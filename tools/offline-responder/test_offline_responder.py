#!/usr/bin/env python3
"""Pruebas de offline-responder contra un Telegram falso local.

Se corre con: python3 tools/offline-responder/test_offline_responder.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "offline-responder")
PAIRED_USER_ID = 4242
LAST_UPDATE_ID = 7


def text_update(update_id, text, user_id=PAIRED_USER_ID):
    return {
        "update_id": update_id,
        "message": {
            "message_id": update_id * 10,
            "date": 0,
            "chat": {"id": user_id, "type": "private"},
            "from": {"id": user_id, "is_bot": False, "first_name": "CEO"},
            "text": text,
        },
    }


class FakeTelegram:
    """Bot API falsa: registra cada llamada y responde lo que le indique el test.

    El estado vive aca y no en el servidor HTTP porque BaseHTTPRequestHandler
    solo expone `self.server` con el tipo base.
    """

    def __init__(self):
        self.calls = []
        self.updates = []
        self.get_updates_status = 200
        self.lock = threading.Lock()
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.http.daemon_threads = True

    @property
    def base_url(self):
        return "http://127.0.0.1:%d" % self.http.server_address[1]

    def calls_to(self, method):
        with self.lock:
            return [call for call in self.calls if call["method"] == method]


STATE = FakeTelegram.__new__(FakeTelegram)  # reemplazado en cada setUp


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 (firma impuesta por la clase base)
        pass

    def do_POST(self):  # noqa: N802 (nombre impuesto por BaseHTTPRequestHandler)
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode("utf-8")
        params = {key: values[0] for key, values in parse_qs(raw).items()}
        method = self.path.rsplit("/", 1)[-1]
        with STATE.lock:
            STATE.calls.append({"method": method, "params": params})
            updates = list(STATE.updates)
            status = STATE.get_updates_status

        if method == "getUpdates":
            if status != 200:
                self._reply(status, {"ok": False, "error_code": status, "description": "Conflict"})
                return
            offset = int(params.get("offset", "0"))
            self._reply(200, {"ok": True, "result": [u for u in updates if u["update_id"] >= offset]})
            return
        self._reply(200, {"ok": True, "result": {"message_id": 999}})

    def _reply(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class OfflineResponderTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="pi-telegram-offline-")
        os.makedirs(os.path.join(self.home, ".pi", "agent"))
        self.telegram_config = os.path.join(self.home, ".pi", "agent", "telegram.json")
        self.heartbeat = os.path.join(self.home, ".pi", "agent", "telegram-heartbeat.json")
        self.cache = os.path.join(self.home, "cache")
        with open(self.telegram_config, "w", encoding="utf-8") as handle:
            json.dump(
                {"botToken": "123:TEST", "allowedUserId": PAIRED_USER_ID, "lastUpdateId": LAST_UPDATE_ID},
                handle,
            )

        global STATE
        self.server = FakeTelegram()
        STATE = self.server
        threading.Thread(target=self.server.http.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.http.shutdown()
        self.server.http.server_close()
        shutil.rmtree(self.home, ignore_errors=True)

    def write_heartbeat(self, age_seconds):
        with open(self.heartbeat, "w", encoding="utf-8") as handle:
            json.dump({"pid": os.getpid(), "updatedAt": int((time.time() - age_seconds) * 1000)}, handle)

    def run_once(self):
        env = dict(os.environ)
        env.update({
            "HOME": self.home,
            "PI_TELEGRAM_OFFLINE_CACHE": self.cache,
            "PI_TELEGRAM_OFFLINE_API": self.server.base_url,
        })
        proc = subprocess.run(
            [sys.executable, SCRIPT, "once"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
        return proc.stdout.decode("utf-8", "replace")

    # --- Casos -------------------------------------------------------------
    def test_fresh_heartbeat_never_calls_telegram(self):
        self.write_heartbeat(age_seconds=5)
        self.server.updates = [text_update(LAST_UPDATE_ID + 1, "hola")]

        self.run_once()

        self.assertEqual(self.server.calls, [], "con pi escuchando no se toca la Bot API")

    def test_stale_heartbeat_answers_once_without_confirming_updates(self):
        self.write_heartbeat(age_seconds=600)
        self.server.updates = [
            text_update(LAST_UPDATE_ID + 1, "primera"),
            text_update(LAST_UPDATE_ID + 2, "segunda"),
        ]

        self.run_once()

        polls = self.server.calls_to("getUpdates")
        self.assertEqual(len(polls), 1)
        # La invariante: nunca un offset mayor a lastUpdateId + 1, para no confirmar nada.
        self.assertEqual(polls[0]["params"]["offset"], str(LAST_UPDATE_ID + 1))

        sent = self.server.calls_to("sendMessage")
        self.assertEqual(len(sent), 1, "una sola respuesta por tanda")
        self.assertIn("apagado", sent[0]["params"]["text"])
        self.assertEqual(sent[0]["params"]["chat_id"], str(PAIRED_USER_ID))
        self.assertEqual(
            json.loads(sent[0]["params"]["reply_parameters"])["message_id"],
            (LAST_UPDATE_ID + 1) * 10,
        )

    def test_missing_heartbeat_is_treated_as_offline(self):
        self.server.updates = [text_update(LAST_UPDATE_ID + 1, "hola")]

        self.run_once()

        self.assertEqual(len(self.server.calls_to("sendMessage")), 1)

    def test_second_pass_does_not_repeat_the_answer(self):
        self.write_heartbeat(age_seconds=600)
        self.server.updates = [text_update(LAST_UPDATE_ID + 1, "hola")]

        self.run_once()
        self.run_once()

        self.assertEqual(len(self.server.calls_to("getUpdates")), 2)
        self.assertEqual(len(self.server.calls_to("sendMessage")), 1)
        for poll in self.server.calls_to("getUpdates"):
            self.assertEqual(poll["params"]["offset"], str(LAST_UPDATE_ID + 1))

    def test_new_message_after_an_answered_batch_is_answered(self):
        self.write_heartbeat(age_seconds=600)
        self.server.updates = [text_update(LAST_UPDATE_ID + 1, "hola")]
        self.run_once()

        self.server.updates = self.server.updates + [text_update(LAST_UPDATE_ID + 2, "seguis ahi?")]
        self.run_once()

        self.assertEqual(len(self.server.calls_to("sendMessage")), 2)

    def test_conflict_means_pi_came_back_and_nothing_is_sent(self):
        self.write_heartbeat(age_seconds=600)
        self.server.updates = [text_update(LAST_UPDATE_ID + 1, "hola")]
        self.server.get_updates_status = 409

        self.run_once()

        self.assertEqual(len(self.server.calls_to("getUpdates")), 1)
        self.assertEqual(self.server.calls_to("sendMessage"), [])

    def test_messages_from_other_accounts_are_ignored(self):
        self.write_heartbeat(age_seconds=600)
        self.server.updates = [text_update(LAST_UPDATE_ID + 1, "hola", user_id=999)]

        self.run_once()

        self.assertEqual(self.server.calls_to("sendMessage"), [])


    def test_damaged_config_falls_back_to_the_backup_without_touching_it(self):
        self.write_heartbeat(age_seconds=600)
        damaged = '{"botToken": "123:TEST", "allowedUs'
        with open(self.telegram_config + ".bak", "w", encoding="utf-8") as handle:
            json.dump({"botToken": "123:TEST", "allowedUserId": PAIRED_USER_ID, "lastUpdateId": LAST_UPDATE_ID}, handle)
        with open(self.telegram_config, "w", encoding="utf-8") as handle:
            handle.write(damaged)
        self.server.updates = [text_update(LAST_UPDATE_ID + 1, "hola")]

        self.run_once()

        self.assertEqual(len(self.server.calls_to("sendMessage")), 1)
        with open(self.telegram_config, "r", encoding="utf-8") as handle:
            self.assertEqual(handle.read(), damaged, "restaurar es trabajo de pi, no del responder")

    def test_damaged_config_without_backup_does_nothing_and_does_not_crash(self):
        self.write_heartbeat(age_seconds=600)
        with open(self.telegram_config, "w", encoding="utf-8") as handle:
            handle.write('{"botToken": "123:TE')
        self.server.updates = [text_update(LAST_UPDATE_ID + 1, "hola")]

        self.run_once()

        self.assertEqual(self.server.calls, [])

if __name__ == "__main__":
    unittest.main(verbosity=2)
