"""
NetWatch — entry point.
Usage:
    python run.py
"""
from netwatch.app             import create_app, start_background_tasks
from netwatch.socketio_instance import socketio

app = create_app()

if __name__ == "__main__":
    print("🌐 NetWatch → http://0.0.0.0:8000")
    start_background_tasks()
    # socketio.run вместо app.run — обязательно для WebSocket
    socketio.run(
        app,
        host="0.0.0.0",
        port=8000,
        debug=False,
        use_reloader=False,   # reloader несовместим с daemon threads
        log_output=False,
    )