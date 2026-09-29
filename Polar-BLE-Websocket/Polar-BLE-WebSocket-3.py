# Polar-BLE-WebSocket-3.py
import asyncio
from bleak import BleakClient, BleakScanner
import websockets
from collections import deque

# UUID:t
HR_UUID = "00002a37-0000-1000-8000-00805f9b34fb"
PMD_CONTROL = "FB005C81-02E7-F387-1CAD-8ACD2D8DF0C8"
PMD_DATA = "FB005C82-02E7-F387-1CAD-8ACD2D8DF0C8"

MEAS_TYPE_PPI = 3
MEAS_TYPE_ACC = 2

# tila
ppi_valid = False
skin_contact = False
last_contact_state = None
latest_hr = None

# HR-puskuri (viimeiset 5 arvoa)
hr_buffer = deque(maxlen=5)

# WebSocket-yhteydet
CONNECTED_CLIENTS = set()

# --- Parsijat ---

def parse_hr(data: bytearray) -> int:
    """Parse Heart Rate Measurement (0x2A37)"""
    hr_format = data[0] & 0x01
    if hr_format == 0:
        return data[1]
    else:
        return int.from_bytes(data[1:3], "little")

def parse_ppi_payload(payload: bytearray):
    """Parse PPI payload"""
    if len(payload) < 6:
        return None
    hr = payload[0]
    ppi = int.from_bytes(payload[1:3], "little")
    error = int.from_bytes(payload[3:5], "little")
    flags = payload[5]
    valid = not (flags & 0x01)
    sc = (flags & 0x02) != 0
    if not valid:
        sc = False
    return hr, ppi, error, valid, sc

# --- Callbackit ---

def handle_hr(sender, data: bytearray):
    global latest_hr
    try:
        hr = parse_hr(data)
        hr_buffer.append(hr)  # lisää puskuriin
        latest_hr = hr
        print(f"HR: {hr} bpm (buffer: {list(hr_buffer)})")
    except Exception as e:
        print("HR parse error:", e)

def handle_pmd(sender, data: bytearray):
    global ppi_valid, skin_contact, last_contact_state
    try:
        meas_type = data[0] & 0x3F
    except Exception:
        return

    if meas_type not in (MEAS_TYPE_PPI, MEAS_TYPE_ACC):
        return

    payload = data[10:]
    if meas_type == MEAS_TYPE_PPI:
        parsed = parse_ppi_payload(payload)
        if parsed:
            hr, ppi, err, valid, sc = parsed
            old_state = (ppi_valid and skin_contact)
            ppi_valid, skin_contact = valid, sc
            new_state = (ppi_valid and skin_contact)
            if old_state != new_state:
                if new_state:
                    print("Contact confirmed")
                else:
                    print("No confirmed contact")

# --- BLE-yhteys ---

async def run_client(device):
    async with BleakClient(device) as client:
        print(f"Connected: {device.name}")
        await client.start_notify(HR_UUID, handle_hr)

        try:
            await client.write_gatt_char(PMD_CONTROL, bytes([1, MEAS_TYPE_PPI]))
            await client.write_gatt_char(PMD_CONTROL, bytes([2, MEAS_TYPE_PPI]))
        except Exception:
            pass

        try:
            await client.write_gatt_char(PMD_CONTROL, bytes([1, MEAS_TYPE_ACC]))
            await client.write_gatt_char(PMD_CONTROL, bytes([2, MEAS_TYPE_ACC]))
        except Exception:
            pass

        await client.start_notify(PMD_DATA, handle_pmd)

        print("Listening... (Ctrl+C to stop)")
        while True:
            await asyncio.sleep(1)

# --- WebSocket ---

async def register(websocket):
    CONNECTED_CLIENTS.add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        CONNECTED_CLIENTS.remove(websocket)

async def send_hr_updates():
    while True:
        if CONNECTED_CLIENTS and hr_buffer and ppi_valid and skin_contact:
            avg_hr = sum(hr_buffer) // len(hr_buffer)
            msg = str(avg_hr)
            print(f"Sending avg HR: {msg} BPM to {len(CONNECTED_CLIENTS)} clients")
            # ÄLÄ awaittaa broadcastia
            websockets.broadcast(CONNECTED_CLIENTS, msg)
        await asyncio.sleep(5)


async def main():
    # BLE-scan + yhteys
    async def ble_task():
        while True:
            print("Scanning for Polar...")
            devices = await BleakScanner.discover()
            polar = next((d for d in devices if d.name and "Polar" in d.name), None)
            if not polar:
                print("No Polar device found, retrying...")
                await asyncio.sleep(5)
                continue
            try:
                await run_client(polar)
            except Exception as e:
                print("Connection lost:", e)
                await asyncio.sleep(5)

    # WebSocket-serveri
    async def ws_task():
        print("Starting HR WebSocket server ws://localhost:8765")
        async with websockets.serve(register, "localhost", 8765):
            await send_hr_updates()

    await asyncio.gather(ble_task(), ws_task())

if __name__ == "__main__":
    asyncio.run(main())
