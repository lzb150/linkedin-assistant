<h1><img alt="Setup" src="headers/setup.png" width="960"></h1>

> **//** Part of [linkedin-assistant](../README.md). Install and jack in once, check a run by hand, then hand the schedule to the launchd daemons.
>
> 🇺🇦 [Українською](setup.uk.md)

## One-time setup

> **`// HEADS-UP` · Requires macOS** — scheduling (launchd), notifications, and the Dock apps
> are Mac-only. Node.js 20+.

```bash
cd ~/linkedin-assistant
npm install                      # installs playwright
npx playwright install chromium  # downloads the browser

cp ~/path/to/your-resume.txt resume.txt   # plain text; drives scoring and the letters
node make-skills.mjs             # builds skills.json — WHAT it looks for
$EDITOR jobs.config.json         # WHERE it looks: feeds, searches, your country

node login.mjs                   # YOU log in manually (handles 2FA). Never stores your password.
```

**`resume.txt`** is the one file the tool cannot invent. Paste the full text —
`make-skills.mjs` reads it to draft the keyword profile every vacancy is first
screened against, and the local LLM re-scores each posting against it later.
Run `node make-skills.mjs --print` first if you want to see the profile before
it is written; read the result once either way, and adjust the weights.

**`jobs.config.json`** ships pointed at QA automation vacancies. That is the
step nothing can do for you: it is a choice of boards and search wording, not a
fact to extract from a resume. Change the DOU feeds, the Djinni search URLs and
the LinkedIn queries to your own field, and set `candidateCountry` to where you
live — see [Specifying your specialization](specialization.md).

`login.mjs` opens a real browser, and you jack in yourself. Log in fully (2FA included); it detects the
login by itself, saves the session into `.browser-profile/` and closes. It gives
up after 6 minutes without saving anything — just re-run it. Pass `djinni` to
log in there too: `node login.mjs djinni`.

Then check it works before putting it on a schedule:

```bash
node jobs.mjs        # one pass over every enabled source
node dashboard.mjs   # build applications/index.html and look at what it found
```

## Phone alerts (Telegram, optional)

Banners only reach you at the Mac. To get the same alerts on your phone, connect
a Telegram bot of your own. Each new package arrives as its own message linked
to the vacancy, each new LinkedIn message links to its thread, and Djinni
messages, an expired session or a broken source come through too.

1. In Telegram, open **@BotFather**, send `/newbot` and pick a name.
2. Send your new bot any message (a bot cannot write to you first).
3. Run `node telegram-setup.mjs <token from BotFather>`. It finds your chat,
   sends a test message and writes `telegram.json` (gitignored, readable by you
   alone).

Alerts are queued in `telegram-outbox/` and posted by a background process, so
a Mac that wakes up without network yet sends them a few minutes later instead
of losing them. Anything still unsent after two days is dropped. The log is
`logs/telegram_YYYYMMDD.log`; delete `telegram.json` to turn the alerts off.

What leaves the Mac is the alert text: job title, company and LLM verdict, the
recruiter's name and the start of their message. Nothing else does. Like every
run, the alerts need the Mac awake; to keep a Mac on the charger awake with the
lid closed, see [below](#keep-the-mac-awake-with-the-lid-closed-optional).

## Schedule it (launchd)

What the daemons run, and when:

| Job (plist example)                              | Frequency              |
|--------------------------------------------------|------------------------|
| LinkedIn inbox check (`linkedin-assistant`)      | hourly                 |
| Djinni inbox check + auto-bump (`djinni-inbox`)  | hourly                 |
| DOU / Djinni discovery (`job-discovery-dou`)     | hourly                 |
| Full discovery incl. LinkedIn (`job-discovery-linkedin`) | every 3 hours (at :45) |
| LinkedIn catch-up after a DarkWake (`linkedin-catchup`) | every 15 min (no-op unless pending) |
| Closed-vacancy check + archive (`closed-check`)  | daily 08:30            |
| Weekly report (`jobs-report`)                    | Monday 09:00           |
| Dock badge daemon (`jobs-badge`)                 | always on (KeepAlive)  |
| Dashboard state server (`state-server`)         | always on (KeepAlive)  |

The run wrappers and launchd agents are machine-specific (absolute paths,
your resume location), so they ship as `*.example` templates. Copy each, fill in
your own values, and the real copies stay local (gitignored):

```bash
cp run.sh.example run.sh   # then edit node version + RESUME_PATH
cp com.example.linkedin-assistant.plist.example com.you.linkedin-assistant.plist  # replace YOUR_USERNAME **and** the Label inside
cp com.you.linkedin-assistant.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.you.linkedin-assistant.plist
```

Unload to stop: `launchctl unload ~/Library/LaunchAgents/com.you.linkedin-assistant.plist`.
Discovery has its own templates: `com.example.job-discovery-dou.plist.example`
and `com.example.job-discovery-linkedin.plist.example`; the dashboard's state
server is `com.example.state-server.plist.example` (always on, also set the node path).

**LinkedIn and a sleeping Mac.** A schedule the Mac slept through fires in the
next DarkWake — a 5–10 s background wake — and on battery `caffeinate -s` cannot
hold the Mac up, so the LinkedIn feed never loaded there (`page.goto: Timeout
30000ms`, LinkedIn 0 found). `jobs.mjs` now checks `pmset` first: in a DarkWake
on battery it still runs DOU and Djinni, logs `linkedin: deferred`, leaves
LinkedIn out of health monitoring and writes a `linkedin-pending` marker.
`com.example.linkedin-catchup.plist.example` (`LINKEDIN_CATCHUP=1 run.sh
jobs.mjs`, every 15 min) exits at once without the marker; with it and the Mac
fully awake it scrapes LinkedIn only and removes the marker. On AC power nothing
is deferred. A LinkedIn run that finds the browser profile or the run lock busy
(an overlapping `check.mjs` or `jobs.mjs`) leaves the same marker, so LinkedIn
is retried within 15 minutes instead of at the next 3-hour slot.

## Keep the Mac awake with the lid closed (optional)

Runs and alerts stop while the Mac sleeps, and a MacBook sleeps as soon as its
lid closes. If the Mac stays home on the charger while you are out, the
`com.example.lid-awake.plist.example` LaunchDaemon keeps it working. Every 10
seconds it checks the power source:

| Power   | What it does |
|---------|--------------|
| Charger | `pmset -a disablesleep 1`: the Mac does not sleep, lid closed included. The screen still turns off. |
| Battery | `pmset -a disablesleep 0`: normal sleep. If the lid is already closed, `pmset sleepnow`, so an unplugged Mac in a bag does not stay awake. |

It is a system daemon (it runs `pmset` as root), so installing it asks for your
Mac password. Nothing in it needs editing:

```bash
sudo install -m 644 -o root -g wheel com.example.lid-awake.plist.example /Library/LaunchDaemons/com.example.lid-awake.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.lid-awake.plist
pmset -g | grep SleepDisabled   # 1 while on the charger
```

To remove it and turn normal sleep back on:

```bash
sudo launchctl bootout system/com.example.lid-awake
sudo rm /Library/LaunchDaemons/com.example.lid-awake.plist
sudo pmset -a disablesleep 0
```

Worth knowing:
- On the charger the Mac does not sleep at night either; only the screen turns off.
- An unplugged Mac with a closed lid stays awake for up to 10 seconds.
- Keep a closed Mac on the charger on a hard surface, not a blanket.
