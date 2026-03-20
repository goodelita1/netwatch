"""
NetWatch — Configuration & constants
"""
import os

# ── Убраны пути к JSON файлам — теперь всё в SQLite ──────────────────────────
# Оставлены только те константы которые реально используются в коде

POWER_IP  = "192.168.88.1"   # шлюз-индикатор питания: если offline → «нет света»
PHIST_MAX = 144               # глубина ring buffer (144 × 60с ≈ 2.4ч)

AUTH_FILE = "auth.json"       # используется auth.py для backward-compat при первом запуске