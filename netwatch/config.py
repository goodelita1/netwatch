"""
NetWatch — Configuration & constants
"""
import os

DEVICES_FILE  = "devices.json"
SUBNETS_FILE  = "subnets.json"
EVENTS_FILE   = "events.json"
TG_FILE       = "telegram.json"
POWER_IP      = "192.168.88.1"   # gateway — if offline → power outage

# Ping history depth: 144 × 60s ≈ 2.4h
PHIST_MAX = 144

AUTH_FILE     = "auth.json"
