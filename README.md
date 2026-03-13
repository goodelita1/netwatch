# ⬡ NetWatch — Мониторинг сетевой инфраструктуры

Лёгкое веб-приложение на Python/Flask для мониторинга устройств в локальной сети.  
Без базы данных, без Docker — один файл `app.py`, запускается за 10 секунд.

---

## Возможности

### 📡 Мониторинг
- Авто-пинг всех устройств каждые **60 секунд** в фоне
- Отображение задержки (пинга) с цветовой индикацией: зелёный / жёлтый / красный
- Группировка устройств по подсетям
- Фильтрация: все / онлайн / оффлайн / по типу
- Сортировка по любому столбцу (IP, название, расположение, тип, пинг)

### ⚡ Индикатор питания (света)
Баннер в верхней части мониторинга — показывает есть ли электричество на предприятии:
- **Зелёный** — `192.168.88.1` (главный шлюз) отвечает → свет есть
- **Красный (пульсирует)** — шлюз не пингуется → вероятно отключение электроэнергии

IP шлюза задаётся константой `POWER_IP` в коде.

### 🔬 Глубокий скан
- Определение MAC-адреса из ARP-таблицы
- Определение вендора по OUI (офлайн-база: MikroTik, Ubiquiti, Hikvision, ASUS, Apple, TP-Link, Cisco, VMware и др.)
- Фингерпринтинг модели по открытым портам (RouterOS, UniFi AP, IP Camera, NAS и др.)
- Прогресс-бар в реальном времени
- Результаты (vendor / model / mac) сохраняются в `devices.json` — не теряются при перезапуске

### 🤖 Авто-сканирование сети
Фоновые задачи без ручного вмешательства:

| Задача | Интервал | Что делает |
|--------|----------|------------|
| Авто-скан хостов | каждые **5 минут** | Пингует все адреса `.1–.254` зарегистрированных подсетей, находит незарегистрированные устройства |
| Авто-скан подсетей | каждые **15 минут** | Пингует шлюзы `192.168.0–255.1`, находит новые подсети |

Результаты выводятся на главной странице с кнопками **+ Добавить** / **+ Реестр**.

### 🔍 Сканер хостов
- Ручной запуск сканирования выбранных подсетей (`.1–.254`)
- Разделение на: незарегистрированные / уже в базе
- Прогресс-бар в реальном времени

### 🛰 Сканер диапазона подсетей
- Пингует шлюзы всех 256 подсетей `192.168.0–255.0/24`
- Показывает новые и уже известные подсети

### 🗂 Реестр подсетей
- Управление списком подсетей
- Автодобавление при регистрации нового устройства

### ⟳ Перезагрузка устройств
Многоуровневая система: пробует методы по очереди, останавливается на первом успешном.

| Метод | Для кого |
|-------|---------|
| MikroTik REST API (`/rest/system/reboot`) | RouterOS 7.x |
| MikroTik Binary API (порт 8728) | RouterOS 6.x |
| SSH через `paramiko` (`/system reboot` via stdin) | Все версии RouterOS |
| Hikvision ISAPI | IP-камеры Hikvision |
| Dahua HTTP CGI | IP-камеры Dahua |
| ASUS HTTP API | Роутеры/точки доступа ASUS |
| Generic HTTP | Неизвестные устройства |
| SSH generic (`reboot`) | Последний fallback |

---

## Установка

### Требования
- Python 3.8+
- pip

### Зависимости
```bash
pip install flask paramiko
```

> `paramiko` нужен для перезагрузки устройств через SSH с паролем (без sshpass).

### Запуск
```bash
python app.py
```

Приложение будет доступно по адресу: **http://0.0.0.0:8000**

---

## Структура данных

Все данные хранятся в двух JSON-файлах рядом с `app.py`:

### `devices.json`
Список устройств. Создаётся автоматически при первом запуске с демо-данными.

```json
[
  {
    "id": 1,
    "ip": "192.168.88.1",
    "name": "Main Router",
    "location": "Серверная",
    "type": "router",
    "mac": "4C:5E:0C:AA:BB:CC",
    "vendor": "MikroTik",
    "model": "MikroTik RouterOS",
    "cred_login": "admin",
    "cred_password": "пароль_хранится_в_plaintext"
  }
]
```

**Типы устройств:** `router` · `ap` · `camera` · `client` · `mobile` · `server`

### `subnets.json`
Реестр подсетей.

```json
[
  { "prefix": "192.168.88", "label": "192.168.88.0/24", "scan": true }
]
```

> ⚠️ Пароли хранятся в открытом виде в `devices.json`. Не используйте на публично доступных серверах без дополнительной защиты.

---

## API

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/devices` | Список устройств со статусами |
| POST | `/api/devices` | Добавить устройство |
| PUT | `/api/devices/<id>` | Обновить устройство |
| DELETE | `/api/devices/<id>` | Удалить устройство |
| GET | `/api/subnets` | Список подсетей |
| POST | `/api/subnets` | Добавить подсеть |
| PUT | `/api/subnets/<prefix>` | Обновить подсеть |
| DELETE | `/api/subnets/<prefix>` | Удалить подсеть |
| POST | `/api/scan` | Запустить быстрый пинг |
| POST | `/api/deep_scan` | Запустить глубокий скан |
| GET | `/api/deep_scan/status` | Прогресс глубокого скана |
| GET | `/api/ping/<ip>` | Пинг одного устройства |
| POST | `/api/reboot/<id>` | Перезагрузить устройство |
| POST | `/api/discovery/start` | Запустить сканер хостов |
| GET | `/api/discovery/status` | Статус сканера хостов |
| POST | `/api/subnet_scan/start` | Запустить сканер подсетей |
| GET | `/api/subnet_scan/status` | Статус сканера подсетей |
| GET | `/api/auto_scan/status` | Статус авто-сканирования |

---

## Настройка

### Изменить IP шлюза для индикатора питания
В `app.py` найдите и измените:
```javascript
const POWER_IP = '192.168.88.1';
```

### Добавить вендора в OUI-базу
В `app.py` в словарь `OUI_DB` добавьте запись:
```python
"XX:XX:XX": "VendorName",
```
Первые три октета MAC-адреса (OUI) → название вендора.

### Изменить интервалы авто-скана
В `app.py`:
```python
def background_auto_discovery():
    time.sleep(90)   # задержка при старте (секунды)
    while True:
        ...
        time.sleep(300)  # интервал (секунды) — 300 = 5 минут

def background_auto_subnet():
    time.sleep(180)  # задержка при старте
    while True:
        ...
        time.sleep(900)  # 900 = 15 минут
```

---

## Запуск как системный сервис (Linux)

```ini
# /etc/systemd/system/netwatch.service
[Unit]
Description=NetWatch Network Monitor
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/netwatch
ExecStart=/usr/bin/python3 /opt/netwatch/app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable netwatch
sudo systemctl start netwatch
```

---

## Стек

| Компонент | Технология |
|-----------|-----------|
| Backend | Python 3, Flask |
| Сканирование | asyncio + asyncio.open_connection |
| SSH | paramiko |
| Frontend | Vanilla JS, CSS переменные |
| Шрифты | JetBrains Mono, Syne (Google Fonts) |
| Хранилище | JSON-файлы |
| Фоновые задачи | threading.Thread (daemon) |
