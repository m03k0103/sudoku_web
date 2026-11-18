# -*- coding: utf-8 -*-
r"""
start.py - Sudoku Web OCR サーバー起動管理スクリプト
D:\dev\sudoku_web

機能:
1. 二重起動時の再利用【挙動1】:
   - 起動時に .server_port および 8008/8058 の疎通を確認。
   - すでにサーバーが稼働中（/deploy/index.html が応答）の場合は新規起動せず、ブラウザを開いて終了コード0で終了。
   - --restart 指定時は既存プロセスを安全に停止した上で再起動。
2. ポート設定と自動フォールバック:
   - D:\\dev\\Orchestration\\ports.json があれば "sudoku_web" の定義を参照。
   - デフォルトポート 8008 を優先試行。
   - 競合時はフォールバックポート 8058、さらに 8059〜8099 を自動探索。
3. 状態管理とクリーンアップ:
   - バインドポートを .server_port、プロセスPIDを .server_pid に記録。
   - Orchestration/port_manager.py との完全互換。
   - 正常終了・シグナル終了時に状態ファイルを自動クリーンアップ。
4. 静的ファイル配信:
   - ルート(/) へのアクセスは /deploy/index.html へ自動リダイレクト。
   - OpenCV.js / Tesseract.js / WebAssembly (.wasm) / .gz の適切な MIME タイプ設定。
"""

import argparse
import atexit
import http.server
import json
import os
import signal
import socket
import socketserver
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT_DIR = Path(__file__).resolve().parent
DEPLOY_DIR = ROOT_DIR / "deploy"
SERVER_PORT_FILE = ROOT_DIR / ".server_port"
SERVER_PID_FILE = ROOT_DIR / ".server_pid"
PORTS_JSON_PATH = Path("D:/dev/Orchestration/ports.json")

# デフォルト設定 (ports.json が無い場合のフォールバック値)
DEFAULT_PORT = 8008
DEFAULT_FALLBACK_PORT = 8058
DEFAULT_FALLBACK_RANGE_END = 8060
DEFAULT_HEALTH_PATH = "/deploy/index.html"
DEFAULT_URL_PATH = "/deploy/index.html"


# --- 状態管理・クリーンアップ ---

_is_server_owner = False


def force_cleanup_state_files() -> None:
    """無条件に .server_port および .server_pid を削除"""
    for f in (SERVER_PORT_FILE, SERVER_PID_FILE):
        try:
            if f.exists():
                f.unlink()
        except OSError:
            pass


def cleanup_state_files() -> None:
    """シャットダウン時に .server_port および .server_pid を削除（起動元プロセスのみ）"""
    if not _is_server_owner:
        return
    force_cleanup_state_files()


def record_state_files(port: int, pid: int) -> None:
    """バインドポートとPIDを記録し、本プロセスを状態オーナーに設定"""
    global _is_server_owner
    SERVER_PORT_FILE.write_text(str(port), encoding="utf-8")
    SERVER_PID_FILE.write_text(str(pid), encoding="utf-8")
    _is_server_owner = True


atexit.register(cleanup_state_files)


def handle_exit_signal(sig, frame) -> None:
    cleanup_state_files()
    sys.exit(0)


signal.signal(signal.SIGINT, handle_exit_signal)
if hasattr(signal, "SIGTERM"):
    signal.signal(signal.SIGTERM, handle_exit_signal)


# --- 設定ロード ---

def load_port_config() -> Dict[str, Any]:
    """D:\\dev\\Orchestration\\ports.json から sudoku_web の設定を取得"""
    if PORTS_JSON_PATH.exists():
        try:
            with open(PORTS_JSON_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                projects = data.get("projects", {})
                for name, cfg in projects.items():
                    if name.lower() == "sudoku_web":
                        return {
                            "port": int(cfg.get("port", DEFAULT_PORT)),
                            "fallback_port": int(cfg.get("fallback_port", DEFAULT_FALLBACK_PORT)),
                            "fallback_range_end": int(cfg.get("fallback_range_end", DEFAULT_FALLBACK_RANGE_END)),
                            "health_path": cfg.get("health_path", DEFAULT_HEALTH_PATH),
                            "default_url_path": cfg.get("default_url_path", DEFAULT_URL_PATH),
                        }
        except Exception as e:
            print(f"[WARN] ports.json 読み込み失敗: {e}", file=sys.stderr)
    return {
        "port": DEFAULT_PORT,
        "fallback_port": DEFAULT_FALLBACK_PORT,
        "fallback_range_end": DEFAULT_FALLBACK_RANGE_END,
        "health_path": DEFAULT_HEALTH_PATH,
        "default_url_path": DEFAULT_URL_PATH,
    }


# --- ポート排他・ヘルスチェック ---

def is_port_in_use(port: int) -> bool:
    """ポートが使用中（リッスン中または他プロセスがバインド中）か判定"""
    # 1. 接続確認
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        if s.connect_ex(("127.0.0.1", port)) == 0:
            return True

    # 2. 排他バインド確認 (Windows SO_EXCLUSIVEADDRUSE 対応)
    for bind_host in ("127.0.0.1", "0.0.0.0"):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE") and sys.platform == "win32":
                try:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                except OSError:
                    pass
            try:
                s.bind((bind_host, port))
            except OSError:
                return True
    return False


def is_http_alive(port: int, health_path: str = DEFAULT_HEALTH_PATH, timeout: float = 1.2) -> bool:
    """指定ポートのヘルスチェックエンドポイントが正常応答(HTTP 200〜499)を返すか確認"""
    if not health_path.startswith("/"):
        health_path = "/" + health_path
    url = f"http://127.0.0.1:{port}{health_path}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "SudokuWeb-HealthCheck/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 500
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 500
    except Exception:
        return False


def is_pid_alive(pid: int) -> bool:
    """指定PIDのプロセスが実際に存在するか確認"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).decode("cp932", errors="ignore")
            return str(pid) in out
        except Exception:
            return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def check_already_running(cfg: Dict[str, Any]) -> Tuple[bool, Optional[int], Optional[int]]:
    """
    既存サーバーが起動中か判定【挙動1: サーバー再利用】
    1. .server_port / .server_pid ファイルを確認
    2. プライマリポート (8008) を確認
    3. フォールバックポート (8058) を確認
    """
    health_path = cfg.get("health_path", DEFAULT_HEALTH_PATH)

    # 1. 状態ファイル記録値の確認
    if SERVER_PORT_FILE.exists():
        try:
            p_str = SERVER_PORT_FILE.read_text(encoding="utf-8").strip()
            if p_str.isdigit():
                port = int(p_str)
                pid = None
                if SERVER_PID_FILE.exists():
                    pid_str = SERVER_PID_FILE.read_text(encoding="utf-8").strip()
                    if pid_str.isdigit():
                        pid = int(pid_str)
                if is_http_alive(port, health_path):
                    return True, port, pid
        except Exception:
            pass

    # 2. プライマリポートの稼働確認
    primary = int(cfg.get("port", DEFAULT_PORT))
    if is_http_alive(primary, health_path):
        return True, primary, None

    # 3. フォールバックポートの稼働確認
    fallback = int(cfg.get("fallback_port", DEFAULT_FALLBACK_PORT))
    if is_http_alive(fallback, health_path):
        return True, fallback, None

    return False, None, None


def stop_server_process(pid: Optional[int]) -> bool:
    """既存のサーバープロセスを安全に停止"""
    stopped = False
    if pid and is_pid_alive(pid):
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            try:
                os.kill(pid, 15)
            except OSError:
                pass
        stopped = True
    force_cleanup_state_files()
    return stopped


def find_available_port(cfg: Dict[str, Any]) -> int:
    """
    空きポートを探索:
    1. デフォルトポート (8008)
    2. フォールバックポート (8058)
    3. 8059 〜 8099
    """
    primary = int(cfg.get("port", DEFAULT_PORT))
    if not is_port_in_use(primary):
        return primary

    fallback = int(cfg.get("fallback_port", DEFAULT_FALLBACK_PORT))
    if not is_port_in_use(fallback):
        return fallback

    fb_end = int(cfg.get("fallback_range_end", DEFAULT_FALLBACK_RANGE_END))
    range_max = max(8099, fb_end + 30)
    for p in range(fallback + 1, range_max):
        if not is_port_in_use(p):
            return p

    raise RuntimeError(f"利用可能な空きポートが見つかりませんでした (8008, 8058, {fallback+1}〜{range_max-1} はすべて使用中)。")


# --- HTTP サーバー実装 ---

class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE") and sys.platform == "win32":
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except OSError:
                pass
        super().server_bind()


class SudokuHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """
    Sudoku Web OCR 専用リクエストハンドラ:
    - ルートディレクトリ: D:\\dev\\sudoku_web
    - ルート(/) へのアクセスを /deploy/index.html へリダイレクト
    - キャッシュ無効化ヘッダー付与
    - WebAssembly, JS, GZ 等の適切な Content-Type 提供
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def guess_type(self, path):
        path_lower = path.lower()
        if path_lower.endswith(".wasm"):
            return "application/wasm"
        if path_lower.endswith(".js"):
            return "application/javascript"
        if path_lower.endswith(".css"):
            return "text/css"
        if path_lower.endswith(".json"):
            return "application/json"
        if path_lower.endswith(".gz"):
            return "application/gzip"
        if path_lower.endswith(".png"):
            return "image/png"
        if path_lower.endswith(".jpg") or path_lower.endswith(".jpeg"):
            return "image/jpeg"
        if path_lower.endswith(".html") or path_lower.endswith(".htm"):
            return "text/html"
        return super().guess_type(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        clean_path = self.path.split("?")[0].rstrip("/")
        if clean_path in ("", "/deploy"):
            self.send_response(302)
            self.send_header("Location", "/deploy/index.html")
            self.end_headers()
            return
        super().do_GET()


# --- 起動処理 ---

def run_server(port: Optional[int] = None, open_browser: bool = True) -> None:
    cfg = load_port_config()
    if port is None:
        port = find_available_port(cfg)

    primary_port = int(cfg.get("port", DEFAULT_PORT))
    fallback_port = int(cfg.get("fallback_port", DEFAULT_FALLBACK_PORT))
    default_url_path = cfg.get("default_url_path", DEFAULT_URL_PATH)

    if port != primary_port:
        print(f"[警告] デフォルトポート {primary_port} は他プロセスにより使用中です。")
        print(f"[自動切替] フォールバックポート {port} に自動で切り替えて起動します。")

    try:
        with ThreadedTCPServer(("", port), SudokuHTTPRequestHandler) as httpd:
            # 状態ファイルへの記録
            record_state_files(port, os.getpid())

            url = f"http://localhost:{port}{default_url_path}"
            print("==================================================")
            print("  [*] Sudoku Web OCR Local Server is running!")
            print(f"  URL: {url}")
            print(f"  Port: {port} (PID: {os.getpid()})")
            print("  Root: D:\\dev\\sudoku_web (App: /deploy/index.html)")
            print("  Press Ctrl+C to stop the server.")
            print("==================================================")

            if open_browser:
                webbrowser.open(url)
            httpd.serve_forever()
    except OSError as e:
        print(f"[エラー] ポート {port} へのバインドに失敗しました ({e})。代替ポートを再探索します...")
        cleanup_state_files()
        next_port = find_available_port(cfg)
        if next_port != port:
            run_server(next_port, open_browser=open_browser)
        else:
            raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Sudoku Web OCR Local Server Starter")
    parser.add_argument("-p", "--port", type=int, default=None, help="ポート番号（未指定時は8008/8058を自動判定）")
    parser.add_argument("--restart", action="store_true", help="既存のサーバープロセスを停止して再起動")
    parser.add_argument("--stop", action="store_true", help="稼働中のサーバープロセスを停止して終了")
    parser.add_argument("--no-browser", action="store_true", help="起動時にブラウザを自動オープンしない")
    args = parser.parse_args()

    cfg = load_port_config()
    default_url_path = cfg.get("default_url_path", DEFAULT_URL_PATH)

    # 1. サーバー稼働状態の確認【挙動1: 既存サーバー再利用】
    is_running, running_port, running_pid = check_already_running(cfg)

    if args.stop:
        if is_running:
            stop_server_process(running_pid)
            print(f"[OK] Sudoku Web OCR サーバー (Port: {running_port}, PID: {running_pid}) を停止しました。")
        else:
            force_cleanup_state_files()
            print("[INFO] 稼働中の Sudoku Web OCR サーバーは見つかりませんでした（状態ファイルをクリーンアップしました）。")
        sys.exit(0)

    if is_running:
        if args.restart:
            print(f"[*] 既存サーバー (PID: {running_pid}, Port: {running_port}) を停止して再起動します...")
            stop_server_process(running_pid)
            time.sleep(0.5)
        else:
            url = f"http://localhost:{running_port}{default_url_path}"
            print("==================================================")
            print("  Sudoku Web OCR Local Server")
            print("==================================================")
            print(f"[INFO] 既に Sudoku Web サーバーがポート {running_port} で稼働中です。")
            print(f"[INFO] ブラウザでアプリを開きます: {url}")
            print("       (再起動したい場合は `start.bat --restart` を実行してください)")
            print("==================================================")
            if not args.no_browser:
                webbrowser.open(url)
            sys.exit(0)

    # 停止済みの残骸ファイルがあればクリーンアップ
    force_cleanup_state_files()

    # 2. サーバー起動
    run_server(port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
