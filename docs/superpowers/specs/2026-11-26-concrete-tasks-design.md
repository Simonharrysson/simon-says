# Concrete tasks — design (Simon 2026-11-26, approved in conversation)

Simon: "each bullet got a who when done or whatever you decide on … if the meeting tries to stop, you have to like dismiss those" (meeting tool = föreningar); for companies "suggesting those when, who, what … but not forcing"; Privat = personal recorder (no forcing).

## Fields per task
- **Vem** (person or role; existing owner), **När** (deadline: date or "till nästa möte"; existing due), **Klart när** (measurable result, new field `done_when`).

## Föreningar (forcing, mode "kräv")
1. Notes engine asks Claude to fill all three when said; never invents — missing stays null.
2. Doc: missing fields written visibly: `Boka lokal – Kassör – (deadline?) – (klart när?)`; replaced in place when later said (human edits win as always).
3. Live page: "Uppgifter" panel lists tasks; incomplete ones show a calm prompt "Vem ansvarar och när ska det vara klart?" with "Fråga nu" (highlights) — no status dots, text/icons.
4. Avsluta: if incomplete tasks exist, a dialog lists them; each must be completed inline (type Vem/När/Klart när → written to the Doc) or dismissed ("Lämna som det är"); "Avsluta" enabled when all are handled. Meet-like auto-end (no tab) never blocks — it ends and the summary lists incomplete tasks.
5. Summary e-mails / Från förra veckan / Översikt show deadline + klart när; overdue marked.

## Företag (suggest, later with the space kind): same fields, prompts are suggestions only, Avsluta never asks.
## Privat: no prompts; the e-mail lists tasks with whatever fields are known.

## Setting
Per förening: "Uppgifter: Kräv vem, när och klart när" (default on for föreningar); off = suggest-only behaviour.
