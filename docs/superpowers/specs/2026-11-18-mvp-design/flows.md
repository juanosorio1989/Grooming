# Flows

Reception quick booking, walk-in, cancel/reschedule, manage link, consent
handling and hold lifecycle are as in BeautySpa's `flows.md`, applied to pets.
This page covers what differs.

## Online booking (owner, ≤ 3 steps)

```
1. Pets & services → 2. Time → 3. Phone code + confirm
```

1. **Pets & services.** Returning owner (remembered device or after step 3 of a
   previous booking): pick pets from their list. New owner: add a pet inline —
   name, species, breed, size (weight in lb or pick S/M/L/XL), coat type.
   Then main service per pet + add-ons, price per pet shown. Optional
   "preferred groomer" (or Any). Allergies/temperament are optional here and
   asked again after booking.
2. **Time.** Wait mode: slot list. Drop-off mode: drop-off times with
   "ready around X". Tapping one places a hold (countdown).
3. **Phone + code + confirm.** OTP as BeautySpa; first time also owner name,
   language and the unticked WhatsApp consent checkbox. Confirm → booked.

After booking, the success screen asks once to complete pet profiles
(allergies, temperament, vaccines with card photo, vet). Booking never waits on
it.

Pets created before OTP are kept in the hold's payload and saved to the
customer on confirm **(call)**. If the verified phone belongs to a returning
owner who already has a pet with the same species and a name matching
case-insensitively, the confirm screen asks "Is this your Max (Poodle, 42 lb)?"
Yes → the booking uses the existing pet (its allergies and history); No → a new
pet is created. Reception can merge duplicate pets later (`POST
/staff/pets/:id/merge`, OWNER/RECEPTION, audited) **(call)**.

## Owner area

My pets (profile, vaccines, photos, history of visits with report cards) ·
Upcoming (manage, live tracking when in shop) · Profile & consents ·
Export / delete account (as BeautySpa, now including pets and media).

## Check-in (reception, phone or desktop)

```
Board → appointment → per pet: weigh → before photo → vaccine check → kennel → Received
```

- Weight updates the pet; if the size class changes, show new price/duration
  and re-run availability for that pet's remaining segments (staff mode).
- Vaccines: show status vs. `requiredVaccines`; verify a card (sets
  `verified_by`). Missing/expired → warning, or blocked when
  `vaccinePolicy = BLOCK_CHECKIN`.
- Price adjust (matting, behavior) with reason; audited.
- Marks `RECEIVED`; owner gets the tracking link on WhatsApp.

## Day board (reception)

Desktop: columns per person + a kennels strip; mobile: one person at a time.
Cards show pet, current step, ETA. Drag a segment to another time or person →
move (same transaction mechanism as BeautySpa's staff move; `SLOT_TAKEN` on
conflict). Reception can mark steps on a groomer's behalf. Live via SSE.

## Check-out

Report card shown to the owner on the reception screen or their phone →
record payment (amount, method; optional) → name of person picking up → pet
`PICKED_UP` (kennel freed). All pets picked up → appointment `COMPLETED`.

## Notifications (templates, EN + ES)

| Event | Template | When |
|---|---|---|
| Booked | `appointment.confirmed` | immediately (drop-off shows ready estimate) |
| Reminder | `appointment.reminder_24h`, `appointment.reminder_2h` | as BeautySpa |
| Changed / cancelled | `appointment.changed`, `appointment.cancelled` | as BeautySpa |
| Received | `visit.received` | at check-in, with tracking link |
| Late | `visit.eta_changed` | rules in [tracking](tracking.md) |
| Ready | `visit.ready` | at READY, with tracking + report link |

Router and consent rules copied: no consented channel → nothing sent; reception
sees a "no messages" badge.
