# RRM – Backend (Node.js + Express + PostgreSQL)

API REST pentru resursele din Research Resource Manager. Toate rutele sunt sub
`/api/v1`, iar frontend-ul (http://localhost:5173) le apelează direct, prin CORS.

## Cerințe

- Node.js 18 sau mai nou
- PostgreSQL 17, cu baza de date `rrm_db`

## Baza de date

Varianta 1 – din backup-ul echipei (cu date de test), în pgAdmin: click dreapta
pe Databases → Create → Database `rrm_db`, apoi click dreapta pe `rrm_db` →
Restore… și alegeți fișierul de backup. Sau din linia de comandă:

    createdb -U postgres rrm_db
    pg_restore -U postgres -d rrm_db --no-owner <fișierul de backup>

Varianta 2 – doar structura (fără date), din acest repository:

    createdb -U postgres rrm_db
    psql -U postgres -d rrm_db -f db/schema.sql

Backup-ul nu se urcă pe GitHub: conține parolele (hash) utilizatorilor de test.

## Pornire

1. `npm install`
2. Copiați `.env.example` în `.env` și completați parola de PostgreSQL în
   `DATABASE_URL`:

   | Variabilă      | Exemplu                                                   |
   | -------------- | --------------------------------------------------------- |
   | `PORT`         | `8000`                                                    |
   | `DATABASE_URL` | `postgresql://postgres:parola_ta@localhost:5432/rrm_db`   |
   | `CORS_ORIGIN`  | `http://localhost:5173` (mai multe, separate prin virgulă) |
   | `ALLOW_DEMO_AUTH` | `false` (doar `true` pentru teste fără login, vezi mai jos) |
   | `DEMO_USER_ID` | `a0000000-0000-0000-0000-000000000003` (folosit doar cu `ALLOW_DEMO_AUTH=true`) |
   | `JWT_SECRET`   | un text lung și aleatoriu (semnează token-urile de login) |
   | `JWT_EXPIRES_IN` | `8h` (cât e valabil un login)                           |
   | `ALLOWED_EMAIL_DOMAINS` | `usv.ro` (domeniile acceptate la creare cont; include subdomeniile). Lipsă = `usv.ro`; gol = orice domeniu |

   Fără `JWT_SECRET`, serverul nu pornește.

3. `npm run dev` (sau `npm start`)
4. Verificare: http://localhost:8000/api/v1/health răspunde `{"status":"ok"}`.

## Rute

| Metodă | Adresă                   | Răspuns                                                 |
| ------ | ------------------------ | ------------------------------------------------------- |
| GET    | `/api/v1/health`         | `{"status":"ok"}` dacă baza de date răspunde            |
| GET    | `/api/v1/resources`      | toate resursele; filtre opționale `?type=` și `?status=` |
| GET    | `/api/v1/resources/{id}` | o resursă (404 dacă nu există)                          |
| POST   | `/api/v1/resources`      | creează o resursă (201) – doar administratori           |
| PUT    | `/api/v1/resources/{id}` | înlocuiește resursa (toate câmpurile) – doar administratori |
| DELETE | `/api/v1/resources/{id}` | 204; 409 dacă resursa are rezervări – doar administratori |
| GET    | `/api/v1/locations`      | locațiile (clădire, sală, etaj)                         |

## Autentificare (KAN-19)

| Metodă | Adresă                  | Răspuns |
| ------ | ----------------------- | ------- |
| POST   | `/api/v1/auth/login`    | `{token, user}`; 401 „Email sau parolă greșită.” |
| POST   | `/api/v1/auth/register` | 201 + `{token, user}`; 409 dacă emailul există, 400 cu `errors` pe câmpuri |
| GET    | `/api/v1/auth/me`       | utilizatorul din token |

- Corp login: `{"email": "...", "password": "..."}`.
- Corp register: `full_name`, `email`, `password` (min. 8 caractere, litere și
  cifre) și opțional `phone`, `department`, `laboratory`, `academic_title`.
  Conturile noi au rolul `RESEARCHER`; administratorii se stabilesc separat (KAN-20).
- Parolele se salvează doar ca hash bcrypt (`password_hash`), niciodată în clar.
- Frontend-ul trimite token-ul la fiecare cerere: `Authorization: Bearer <token>`.
  Fără token, rutele cu „utilizatorul curent” răspund 401.
- Doar pentru teste (Postman, curl): cu `ALLOW_DEMO_AUTH=true`, o cerere fără
  token folosește antetul `X-User-Id` sau `DEMO_USER_ID`. Implicit e oprit.
- La creare cont se acceptă doar emailurile din `ALLOWED_EMAIL_DOMAINS`.
- SSO cu contul universității (Microsoft) are nevoie de înregistrarea aplicației
  de către departamentul IT; până atunci folosim login cu email și parolă.

## Roluri și utilizatori (KAN-20)

Două roluri (constrângerea `users_role_check`):

- `RESEARCHER` – student / cercetător: caută resurse și face rezervări;
- `ADMINISTRATOR` – cadru didactic / responsabil de laborator: administrează
  resursele și conturile. Trigger-ul `trg_reservations_researcher` nu îi lasă
  să facă rezervări (403).

Rolul se citește din baza de date la fiecare cerere (`src/current-user.js`),
deci o schimbare de rol se aplică imediat, fără un nou login.

| Metodă | Adresă                     | Răspuns |
| ------ | -------------------------- | ------- |
| GET    | `/api/v1/users`            | toți utilizatorii – doar administratori |
| PATCH  | `/api/v1/users/{id}/role`  | `{"role": "ADMINISTRATOR"}` sau `RESEARCHER`; 409 pentru propriul cont sau pentru un administrator responsabil de resurse |

Un cercetător primește 403 la rutele de administrare, iar o cerere fără token 401.

- Schimbarea rolului se face într-o tranzacție, cu administratorii blocați:
  platforma rămâne mereu cu cel puțin un administrator, chiar dacă doi
  administratori se retrogradează reciproc în același timp.
- `responsible_admin_id` al unei resurse trebuie să fie un administrator
  (400 altfel, la POST și PUT `/resources`). La POST fără responsabil,
  responsabilul devine administratorul care creează resursa. La PUT, responsabilul
  e obligatoriu (400 dacă lipsește).
- POST/PUT/DELETE `/resources` și PATCH `/users/{id}/role` reverifică în tranzacție
  că apelantul mai e administrator (403 dacă a fost retrogradat între timp).
- Antetul `Authorization` trebuie să fie `Bearer <token>` (orice majuscule);
  un antet greșit dă 401, fără să se mai folosească `X-User-Id`.

## Indisponibilitate și reparații (KAN-8)

Un administrator marchează o resursă temporar „În revizie” sau „Defect”
pentru un interval de zile. Perioadele stau în tabelul
`unavailability_periods`; rezervările care cad în ele sunt refuzate (422).

| Metodă | Adresă | Răspuns |
| ------ | ------ | ------- |
| GET    | `/api/v1/resources/{id}/unavailability` | perioadele curente și viitoare (orice utilizator logat) |
| POST   | `/api/v1/resources/{id}/unavailability` | `{type, start_date, end_date, details}` – doar administratori; 201 `{period, affected_reservations}` |
| DELETE | `/api/v1/resources/{id}/unavailability/{periodId}` | 204 dacă perioada începe azi sau mai târziu (se șterge); 200 dacă a început înainte de azi și e în curs (se încheie ieri); 409 dacă s-a încheiat |

- `type`: `IN_REVIEW` sau `DEFECT`. Schema nu s-a schimbat: tipul se
  păstrează în `reason` ca `DEFECT: detalii`; motivele vechi fără prefix
  sunt tratate ca „În revizie”.
- Datele sunt zile (`YYYY-MM-DD`, ora României); perioada nu poate începe
  în trecut și nu se poate suprapune cu alta a aceleiași resurse (409).
- `affected_reservations` = rezervările active din perioadă. Nu se anulează
  automat; anunțarea utilizatorilor vine cu notificările.
- `GET /resources` întoarce la fiecare resursă `unavailability`: perioada
  curentă (`active: true`) sau următoarea, ori `null`.

## Rezervările mele (KAN-32)

Rutele lucrează cu rezervările **utilizatorului curent** (cel din token-ul
de login, vezi `src/current-user.js`).

| Metodă | Adresă                                | Răspuns                                          |
| ------ | ------------------------------------- | ------------------------------------------------ |
| GET    | `/api/v1/me/reservations`             | rezervările mele; filtre `?status=` și `?period=upcoming\|past` |
| GET    | `/api/v1/me/reservations/{id}`        | o rezervare (404 dacă nu e a mea)                |
| PATCH  | `/api/v1/me/reservations/{id}/cancel` | rezervarea, cu statusul `CANCELLED`; 409 dacă nu se mai poate anula |

Fiecare rezervare vine cu resursa (`resource_name`, `resource_type`, `requires_approval`),
responsabilul ei (`responsible_name`), locația
(`building`, `room`, `floor`), decizia administratorului (`decision`,
`decision_reason`, `decided_at`) și `can_cancel`. O rezervare se poate anula
dacă are statusul `DRAFT`, `PENDING` sau `APPROVED` și mai sunt cel puțin
`min_cancel_notice_hours` ore (regula resursei) până la început.

Fiecare resursă e întoarsă împreună cu locația ei (`building`, `room`, `floor`).
Exemplu de corp pentru POST/PUT:

    {
      "name": "Robot humanoid NAO v6",
      "description": "Robot programabil pentru interacțiune om-robot",
      "type": "ROBOT",
      "status": "AVAILABLE",
      "location_id": "b0000000-0000-0000-0000-000000000001",
      "responsible_admin_id": "a0000000-0000-0000-0000-000000000001",
      "requires_approval": true,
      "max_consecutive_hours": 2,
      "max_advance_days": 14,
      "min_cancel_notice_hours": 1,
      "attributes": {"senzori": ["camera", "microfon"]}
    }

- `type`: `ROBOT`, `MEASURING_DEVICE`, `COMPUTE_CLUSTER` sau `LAB_ROOM`
- `status`: `AVAILABLE` sau `UNAVAILABLE`
- `name` și `location_id` sunt obligatorii; restul au valori implicite.

## Rezervare nouă și prelungire (KAN-15, KAN-16)

| Metodă | Adresă                                          | Răspuns |
| ------ | ----------------------------------------------- | ------- |
| GET    | `/api/v1/resources/{id}/reservations?from=&to=` | intervalele ocupate ale resursei (`start_time`, `end_time`, `status`, `is_mine`) |
| POST   | `/api/v1/me/reservations`                       | 201 + rezervarea nouă (`PENDING` sau, dacă resursa nu cere aprobare, `APPROVED`) |
| PATCH  | `/api/v1/me/reservations/{id}/extend`           | rezervarea cu noul `end_time` |

Corp pentru POST: `{"resource_id": "...", "start_time": "2026-12-01T08:00:00Z",
"end_time": "2026-12-01T10:00:00Z", "purpose": "..."}`. Pentru PATCH extend:
`{"end_time": "..."}`.

**KAN-16 – reguli** (`src/reservation-rules.js`), răspuns 422 cu mesaj dacă nu
sunt respectate:

- intervalul e în viitor și sfârșitul e după început;
- resursa are statusul `AVAILABLE`;
- durata ≤ `max_consecutive_hours`, începutul ≤ `max_advance_days` zile de azi;
- nu cade într-o perioadă din `unavailability_periods` (ex. calibrare);
- e într-o singură zi, în programul din `availability_windows`
  (ora României); o resursă fără program se poate rezerva oricând.

**KAN-15 – suprapuneri** (`src/overlap.js`), răspuns 409:

- înainte de salvare, verificăm cu funcția `is_resource_free` din baza de date;
- dacă două cereri vin în același timp, constrângerea
  `no_overlapping_reservations` o respinge pe a doua (cod 23P01 → 409);
- la prelungire se verifică doar bucata nouă, dintre vechiul și noul sfârșit.

## Erori

- 400 la date invalide: `{"errors": ["name este obligatoriu", ...]}`
- 400 / 404 / 409 / 422 în rest: `{"error": "mesaj"}`
- 403 dacă un utilizator care nu e cercetător încearcă să rezerve
