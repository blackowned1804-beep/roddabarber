# Rod da Barber — Queue (Phase 1)

A walk-in + appointment queue. Clients scan a QR code, join the line, and get a
**live link** that shows their spot and updates by itself. No texting/SMS yet
(that's Phase 2) — so it's free to run.

## Run it locally

```bash
cd charrod-queue
npm install        # first time only
BARBER_PIN=1234 npm start
```

Then open:

- **Client join:** http://localhost:3000/  (this is what the QR points to)
- **Barber dashboard:** http://localhost:3000/barber  (PIN: 1234)
- **Printable QR:** http://localhost:3000/qr

Change the PIN by setting `BARBER_PIN` to something else.

## How the line is ordered

Each person gets an "effective time":
- **Walk-in** → the moment they joined.
- **Appointment** → their booked time.

The line is sorted by that time. So a 2:00 appointment automatically slots
*ahead* of someone who walked in at 2:10, but *behind* someone already waiting
from 1:45. If an appointment isn't there when it's their turn, the barber taps
**"Not here"** and the app moves on.

"People ahead of you" counts **cuts**, so a dad + 2 sons counts as 3.

## What the barber can do

- See the live line, **Start** the next person, **Done** when finished
- **+ Add client** manually (for people with no smartphone)
- **Open / Closed** toggle and a **Set last call** cut-off time
- Gets an on-screen alert + beep when someone new joins or cancels
- Gets a "take a break / drink water" nudge after every 3 cuts
- **View stats**: cuts by day / week / month / year, by service type, 14-day trend

## Going live (so clients can scan from their own phones)

Right now it only runs on your computer (`localhost`). To put it online so the
QR works on any phone, deploy it to a free host (Render, Railway, or Fly.io all
have free tiers and run Node apps). After deploying:

1. Open `/qr` on the live site, paste the public web address, and re-print.
2. Tape the QR to the workstation.

## Data

Everything is stored in `data.json` next to the server. Stats accumulate across
days. Delete that file to start completely fresh.

## Phase 2 (later): real text messages

When you're ready for actual SMS, we add a texting provider (Twilio). It needs a
paid number (~$2/mo + ~1¢/text) and a one-time business registration that takes
about 1–2 weeks to approve. The app is already structured so the
confirmation / "you moved up" / barber alerts can be sent as texts with no
redesign.
