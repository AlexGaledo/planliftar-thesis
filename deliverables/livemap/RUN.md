# Run guide: Live Map + AR

Everything runs from this folder (`deliverables/livemap`). Needs Python 3.8+
with `websockets` and `cryptography` installed, and an ARCore-capable
Android phone with Chrome.

```
cd deliverables\livemap
pip install websockets cryptography
```

## 1. Start the server (laptop)

```
python server.py --tls
```

Serves the pages over HTTPS on port 8080 and the live-position hub over
WSS on port 8765. The banner prints the exact URLs for every network
address the laptop has. Leave this window open; Ctrl+C stops it.

Use `--tls` whenever a phone is involved. AR in the browser only works on a
secure (https) page. Plain `python server.py` is fine for laptop-only tests.

## 2. Open the map (laptop)

Open the first `https://...:8080` address from the banner in Chrome, e.g.

```
https://192.168.1.42:8080/index.html
```

Chrome warns about the self-signed certificate once: Advanced, then Proceed.

## 3. Open the AR page (phone)

Phone and laptop on the same Wi-Fi, or the phone's hotspot with the laptop
joined to it. In Chrome on the phone, visit two addresses from the banner,
in this order:

1. `https://<laptop-ip>:8765` - accept the certificate warning. The page
   then says "Failed to open a WebSocket connection". That is expected and
   correct; it only exists to store the certificate exception for the hub.
2. `https://<laptop-ip>:8080/ar.html` - accept the warning again. This is
   the AR page.

Skipping step 1 leaves the phone stuck on "Connecting" forever with no
error, because a blocked secure WebSocket never shows a warning.

The laptop address is also printed inside the map's "Phone" panel.

## 4. Use it

On the phone:

1. Tap **Start AR**, allow the camera.
2. Point at the floor until a ring appears, tap **Place**.
3. Pick **Tabletop** (desk-sized model) or **Life-size** (walk through it).
4. Walk. The dot on the laptop map follows.

On the laptop, the same controls appear in the "Model" card once the phone
connects, and drive the phone live.

## 5. Test without a phone

Scripted walker that streams poses to the map from the laptop:

```
python fake_phone.py            # against plain http server
python fake_phone.py --tls      # against --tls server
```

Or open `https://<laptop-ip>:8080/ar.html?fake=1` in any desktop browser.
Either way the map's dot moves in a circle around the plan.

## Choosing a plan

Add `?plan=<name>` to either page. Both pages must show the same plan.

| name | what |
| --- | --- |
| `newri-reference` | default, 9 walls, lightest |
| `bungalow` | hand-authored ground truth |
| `cubicasa` | our own pipeline's export, 244 walls |

Example: `https://192.168.1.42:8080/index.html?plan=bungalow` and
`https://192.168.1.42:8080/ar.html?plan=bungalow`.

## If something is wrong

| Symptom | Fix |
| --- | --- |
| "Start AR" greyed out, note says needs https | You opened an `http://` address or `--tls` was not passed. |
| Phone stuck on "Connecting" | Do step 3.1 (visit port 8765 first, accept the warning). |
| Laptop IP changed (new hotspot session) | Restart `server.py --tls`; it regenerates the certificate. Accept the warnings on the phone again. |
| Dot lands in the wrong place | Phone and laptop are on different plans. Use the same `?plan=`. |
| Model floats in mid-air | Advanced, "Drop onto the floor". |
| Port 8080 or 8765 already in use | Another copy of the server is running. Close it. |
