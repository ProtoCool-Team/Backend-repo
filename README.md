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
   | `DEMO_USER_ID` | `a0000000-0000-0000-0000-000000000003` (doar pentru teste fără login) |
   | `JWT_SECRET`   | un text lung și aleatoriu (semnează token-urile de login) |
   | `JWT_EXPIRES_IN` | `8h` (cât e valabil un login)                           |

3. `npm run dev` (sau `npm start`)
4. Verificare: http://localhost:8000/api/v1/health răspunde `{"status":"ok"}`.

## Rute

| Metodă | Adresă                   | Răspuns                                                 |
| ------ | ------------------------ | ------------------------------------------------------- |
| GET    | `/api/v1/health`         | `{"status":"ok"}` dacă baza de date răspunde            |
| GET    | `/api/v1/resources`      | toate resursele; filtre opționale `?type=` și `?status=` |
| GET    | `/api/v1/resources/{id}` | o resursă (404 dacă nu există)                          |
| POST   | `/api/v1/resources`      | creează o resursă (201)                                 |
| PUT    | `/api/v1/resources/{id}` | înlocuiește resursa (toate câmpurile)                   |
| DELETE | `/api/v1/resources/{id}` | 204; 409 dacă resursa are rezervări                     |
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
  Fără token, rutele cu „utilizatorul curent” răspund 401, cu excepția
  testelor cu `X-User-Id` / `DEMO_USER_ID`.
- SSO cu contul universității (Microsoft) are nevoie de înregistrarea aplicației
  de către departamentul IT; până atunci folosim login cu email și parolă.

## Rezervările mele (KAN-32)

Rutele lucrează cu rezervările **utilizatorului curent**. Până avem login,
utilizatorul curent vine din antetul `X-User-Id` sau, dacă lipsește, din
`DEMO_USER_ID` din `.env` (`src/current-user.js`).

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
