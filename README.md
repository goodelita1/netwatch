# NetWatch

Веб-система мониторинга сетевой инфраструктуры. Пинг, события, SNMP, топология, traceroute, управление устройствами — всё в одном интерфейсе.

![Python](https://img.shields.io/badge/Python-3.10+-blue) ![Flask](https://img.shields.io/badge/Flask-2.3+-green) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Возможности

**Мониторинг**
- Авто-пинг всех устройств каждые 60 секунд
- Статусы онлайн / оффлайн с цветовой индикацией
- Спарклайны пинга (~2.4 часа истории на устройство)
- Баннер питания — если шлюз `192.168.88.1` не отвечает, показывает «НЕТ СВЕТА»
- Группировка устройств по подсетям `/24`
- Пагинация (25 / 50 / 100 / все), поиск, фильтры по типу, сортировка

**Устройства**
- CRUD: добавить, редактировать, удалить
- Поля: IP, имя, расположение, тип, MAC, вендор, модель, логин/пароль для ребута
- Кнопка «🔬 Автозаполнить» в модалке — сканирует IP и заполняет MAC, вендора, модель, тип автоматически

**Групповые действия**
- Чекбоксы на строках и заголовках подсетей
- Групповой пинг (параллельно, батчами по 10)
- Групповой ребут (с предупреждением об устройствах без учётных данных)

**События**
- Автоматическая запись «упал» / «встал» при каждом авто-пинге
- Правильная логика состояний: `None → False → True` без пропусков
- Фильтры: Все / ⚡ Свет / 🔴 Упали / 🟢 Встали / 🔄 Ребут / 🆕 Новые
- Панель тестирования — симулировать DOWN/UP для любого устройства без отключения железа
- Обновление каждые 10 секунд

**Сканер и обнаружение**
- Async-сканер хостов (до 80 параллельных потоков)
- Авто-обнаружение незарегистрированных хостов каждые 5 мин
- Авто-сканирование диапазона `192.168.0–255.1` каждые 15 мин
- Результаты в выпадающем окне прямо в хедере — счётчик новых хостов

**Глубокий скан**
- 26 портов: SSH, HTTP/HTTPS, RTSP, Winbox, Dahua SDK, Hikvision SDK, RDP, WinRM, TR-069, UPnP и др.
- Fingerprint по портам + вендору
- HTTP banner grabbing — определение модели по заголовку `Server:`
- SNMP `sysDescr` для точной идентификации

**SNMP мониторинг** (кнопка 📊 на каждом устройстве)
- Uptime, CPU%, RAM (total/free/used%)
- Все интерфейсы (до 32) — авто-определение индексов
- Тип интерфейса: ethernet / wifi / bridge / loopback / tunnel
- Статус oper/admin (R/S/RS как в Winbox)
- Живой Tx/Rx в bps и packets/s — два замера с интервалом 2с
- MikroTik-специфичные OID: точный CPU, RAM в байтах, напряжение, температура
- Поддержка любого community string

**Перезагрузка устройств**
- MikroTik: REST API (RouterOS 7+) + бинарный API порт 8728 (RouterOS 6)
- Hikvision: ISAPI PUT `/ISAPI/System/reboot`
- Dahua: HTTP CGI `/cgi-bin/magicBox.cgi?action=reboot`
- ASUS: AsusWRT `/apply.cgi`
- Generic HTTP: перебор стандартных reboot-эндпоинтов
- SSH: через `ssh` бинарник или `sshpass`

**Traceroute**
- Вертикальная схема маршрута с хопами
- Нулевой хоп — сам сервер NetWatch
- Цветовые зоны по подсетям, стрелки вниз, задержка справа
- Обогащение хопов данными из базы (имя, вендор, модель)

**Топология сети**
- D3.js force-directed граф
- Умные связи: gateway ↔ устройства подсети, backbone между роутерами, WAN между /16
- Эллипс-зоны по подсетям с подписями
- Gateway отмечен жирной границей и маркером ▲
- Drag & drop узлов, zoom, тултип с деталями и кнопкой Traceroute

**Telegram уведомления**
- Несколько получателей с метками и переключателями
- Типы: питание отключено/восстановлено, устройство N минут недоступно, новый незарег. хост
- Тест-кнопка для каждого получателя отдельно

**OUI база** — 50+ вендоров: MikroTik, Ubiquiti, Hikvision, Dahua, Huawei, Cisco, TP-Link, D-Link, Netgear, ASUS, Apple, Samsung, Xiaomi, Dell, HP, Lenovo, Raspberry Pi, Google, Amazon, Fortinet, Juniper, Aruba, QNAP, Synology и другие.

---

## Структура проекта

```
netwatch/
├── run.py              # Точка входа
├── requirements.txt
├── netwatch/
│   ├── app.py          # Flask application factory
│   ├── routes.py       # Все API-эндпоинты (~40 маршрутов)
│   ├── monitor.py      # Авто-пинг, события, discovery
│   ├── scanner.py      # Async сканер: ping + порты + MAC
│   ├── oui.py          # OUI база, fingerprint, HTTP banner, SNMP движок
│   ├── events.py       # Журнал событий, Telegram, ping history
│   ├── storage.py      # JSON-персистентность (devices, subnets)
│   ├── reboot.py       # Multi-vendor reboot engine
│   ├── auth.py         # Сессионная аутентификация (SHA-256 + salt)
│   └── config.py       # Константы
├── templates/
│   ├── index.html      # Главная SPA
│   └── login.html
└── static/
    ├── css/main.css
    └── js/main.js
```

**Файлы данных** (создаются автоматически в корне проекта):

| Файл | Содержимое |
|------|-----------|
| `devices.json` | База устройств |
| `subnets.json` | Реестр подсетей |
| `events.json` | Журнал событий (последние 1000) |
| `telegram.json` | Настройки Telegram |
| `auth.json` | Хэш пароля |
| `.secret_key` | Ключ сессии Flask |

---

## Быстрый старт

**Требования:** Python 3.10+, macOS / Linux

```bash
# Клонировать
git clone https://github.com/yourname/netwatch.git
cd netwatch

# Зависимости
pip install -r requirements.txt

# Запуск
python run.py
```

Открыть: **http://localhost:8000**

Логин по умолчанию: `admin` / `netwatch` — смените сразу в ⚙️ Настройки.

---

## Установка как системный сервис (macOS LaunchAgent)

Создайте файл `~/Library/LaunchAgents/com.netwatch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.netwatch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/path/to/netwatch/run.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/netwatch</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/netwatch.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/netwatch.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.netwatch.plist
```

**Linux (systemd):**

```ini
[Unit]
Description=NetWatch Network Monitor
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/netwatch
ExecStart=/usr/bin/python3 run.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now netwatch
```

---

## Настройка SNMP на устройствах

**MikroTik:**
```
/snmp set enabled=yes
/snmp community add name=public read-access=yes
```

**Cisco IOS:**
```
snmp-server community public RO
```

**Linux (snmpd):**
```bash
apt install snmpd
echo "rocommunity public" >> /etc/snmp/snmpd.conf
systemctl restart snmpd
```

---

## Настройка Telegram

1. `@BotFather` → `/newbot` → скопировать токен
2. Добавить бота в чат/канал, дать права администратора
3. Получить Chat ID: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. В NetWatch → ⚙️ Настройки → Telegram → вставить токен и Chat ID

---

## API

Все эндпоинты требуют авторизации (cookie-сессия). Базовый URL: `http://host:8000`.

### Устройства
| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/api/devices` | Список устройств со статусами |
| POST | `/api/devices` | Добавить устройство |
| PUT | `/api/devices/<id>` | Обновить устройство |
| DELETE | `/api/devices/<id>` | Удалить устройство |

### Сканирование
| Метод | Путь | Описание |
|-------|------|---------|
| POST | `/api/scan` | Быстрый пинг всех |
| POST | `/api/deep_scan` | Полный скан (порты + MAC + вендор) |
| GET | `/api/scan_host/<ip>` | Полный скан одного хоста |
| GET | `/api/ping/<ip>` | Одиночный пинг + событие |

### SNMP
| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/api/snmp/<ip>` | Полный SNMP опрос (система + интерфейсы) |
| GET | `/api/snmp/<ip>/traffic` | Живой трафик (2 замера, ~4с) |
| GET | `/api/snmp/<ip>/debug` | Сырые OID для диагностики |

Параметр: `?community=public`

### Сеть
| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/api/traceroute/<ip>` | Маршрут до IP |
| GET | `/api/topology` | Граф топологии сети |

### События
| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/api/events` | Журнал событий (`?limit=300`) |
| DELETE | `/api/events` | Очистить журнал |
| POST | `/api/test/event` | Симулировать событие `{"ip":"...","kind":"down"}` |

### Управление
| Метод | Путь | Описание |
|-------|------|---------|
| POST | `/api/reboot/<id>` | Перезагрузить устройство |

---

## Конфигурация

Файл `netwatch/config.py`:

```python
POWER_IP  = "192.168.88.1"   # Шлюз-индикатор питания
PHIST_MAX = 144               # Глубина истории пинга (144 × 60с = 2.4ч)
```

---

## Логика событий

```
prev=None,  alive=False  →  записать время падения, событие НЕ генерируется
prev=None,  alive=True   →  первый скан онлайн, событие НЕ генерируется
prev=False, alive=False  →  всё ещё offline, ничего
prev=False, alive=True   →  событие "встал" ✅
prev=True,  alive=False  →  событие "упал" ✅
prev=True,  alive=True   →  всё ещё online, ничего
```

Это гарантирует что при рестарте сервера нет ложных событий — состояние инициализируется тихо при первом скане, а события генерируются только при реальных переходах.

---

## Требования

| Пакет | Версия |
|-------|--------|
| flask | ≥ 2.3 |
| paramiko | ≥ 3.0 |

`traceroute` — системная утилита, должна быть установлена:
```bash
# macOS (уже есть)
# Linux
apt install traceroute
```

---

## Лицензия

MIT