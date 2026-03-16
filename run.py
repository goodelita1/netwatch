"""
NetWatch — entry point.
Usage:
    python run.py
"""
from netwatch.app import create_app, start_background_tasks

app = create_app()

if __name__ == "__main__":
    print("🌐 NetWatch → http://0.0.0.0:8000")
    start_background_tasks()
    app.run(host="0.0.0.0", port=8000, debug=False, threaded=True)
