"""
NetWatch — Auto-backup module.

Создаёт ZIP-архив netwatch.db раз в сутки.
Хранит последние 30 бэкапов.
Запускается как daemon-поток из app.py.
"""
import os, shutil, time, threading, zipfile, glob

_HERE  = os.path.dirname(os.path.abspath(__file__))
_ROOT  = os.path.dirname(_HERE)
_DB    = os.path.join(_ROOT, "netwatch.db")
_BKDIR = os.path.join(_ROOT, "backups")
_KEEP  = 30        # хранить последних N архивов
_EVERY = 86400     # раз в сутки


def do_backup() -> str | None:
    """
    Создать резервную копию прямо сейчас.
    Возвращает путь к созданному архиву или None при ошибке.
    """
    try:
        os.makedirs(_BKDIR, exist_ok=True)
        ts   = time.strftime("%Y-%m-%d_%H-%M")
        name = f"netwatch_{ts}.zip"
        path = os.path.join(_BKDIR, name)

        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            if os.path.exists(_DB):
                # SQLite hot-backup: copy via shutil to avoid partial write
                tmp = _DB + ".backup_tmp"
                shutil.copy2(_DB, tmp)
                zf.write(tmp, "netwatch.db")
                os.unlink(tmp)

            # Also include any remaining JSON files (for safety)
            for jf in glob.glob(os.path.join(_ROOT, "*.json")):
                zf.write(jf, os.path.basename(jf))

        # Trim old backups
        _trim()
        size_kb = round(os.path.getsize(path) / 1024, 1)
        print(f"[backup] {name} ({size_kb} КБ)")
        return path
    except Exception as e:
        print(f"[backup] error: {e}")
        return None


def list_backups() -> list:
    """Return list of backup info dicts sorted newest-first."""
    os.makedirs(_BKDIR, exist_ok=True)
    files = sorted(glob.glob(os.path.join(_BKDIR, "netwatch_*.zip")), reverse=True)
    result = []
    for f in files:
        stat = os.stat(f)
        result.append({
            "name":       os.path.basename(f),
            "size_kb":    round(stat.st_size / 1024, 1),
            "created_at": stat.st_mtime,
        })
    return result


def _trim():
    """Keep only the last _KEEP archives."""
    files = sorted(glob.glob(os.path.join(_BKDIR, "netwatch_*.zip")))
    for old in files[:-_KEEP]:
        try:
            os.unlink(old)
        except Exception:
            pass


def backup_loop():
    """Background daemon — create backup every _EVERY seconds."""
    # First backup after 5 min (let server warm up)
    time.sleep(300)
    while True:
        do_backup()
        time.sleep(_EVERY)
        