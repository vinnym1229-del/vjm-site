# The newsletter

## What was built, and what was deliberately not

The site now collects newsletter signups into **your own D1 database**
(`vjm-content`, table `newsletter_subscribers`). Three forms feed it: the
homepage section, the prop-firms page, and the "where should I start" quiz
result. All three post to `/api/newsletter/subscribe`.

What is **not** built: sending. There is no email provider wired into this
repository and no credential for one, so nothing here can put a message in an
inbox. Adding a provider means picking one and giving it a key, which is your
decision to make, not one to be made for you by whichever SDK was easiest to
install. Everything below is written so that plugging one in later is a small
job rather than a migration.

The practical consequence today: **someone can subscribe, and you have their
address, but they will not receive anything until you send it.** Do not
advertise a welcome email until there is one.

---

## Reading the list

The whole list, and the only query that matters at send time:

```bash
npx wrangler d1 execute vjm-content --remote \
  --command "SELECT email, first_name, source, created_at
             FROM newsletter_subscribers
             WHERE status = 'subscribed'
             ORDER BY created_at"
```

As CSV, to paste into whatever you send with:

```bash
npx wrangler d1 execute vjm-content --remote --json \
  --command "SELECT email, first_name, unsub_token FROM newsletter_subscribers WHERE status = 'subscribed'" \
  | jq -r '.[0].results[] | [.email, .first_name, .unsub_token] | @csv'
```

`WHERE status = 'subscribed'` is not optional. Rows with
`status = 'unsubscribed'` are people who asked you to stop; they stay in the
table precisely so that a future import cannot quietly re-add them, and
mailing one is the thing CAN-SPAM actually fines you for. If you export
without that clause once, you will not notice until someone complains.

Quick counts:

```bash
npx wrangler d1 execute vjm-content --remote \
  --command "SELECT status, COUNT(*) FROM newsletter_subscribers GROUP BY status"
```

---

## The unsubscribe link — put this in every email

Every subscriber has an `unsub_token`. The link for one person is:

```
https://<your-domain>/api/newsletter/unsubscribe?token=<their unsub_token>
```

One click removes them; no login, no confirmation page, no "are you sure".
They land on `/unsubscribe.html` with a confirmation already done.

Two things to do when you set up sending:

1. **Put that link in the visible footer of every email**, per subscriber.
   Merge the token in the same way you merge a first name.
2. **Set the `List-Unsubscribe` headers** so Gmail and Apple Mail show their
   own one-click unsubscribe button. Mailbox providers weight this heavily
   when deciding whether you land in spam:

   ```
   List-Unsubscribe: <https://<your-domain>/api/newsletter/unsubscribe?token=TOKEN>
   List-Unsubscribe-Post: List-Unsubscribe=One-Click
   ```

   The endpoint answers both `GET` (the footer link) and `POST` (the header),
   so both work with no extra code.

Anyone who has lost the link can also remove themselves at
`/unsubscribe.html` by typing their address. That page never says whether an
address was on the list — answering would turn it into a way for anyone to
check whether a given person is subscribed.

---

## Turning on the bot check

The signup form has a honeypot field, which stops the low-effort submissions.
For the rest, Turnstile is already wired: set `TURNSTILE_SECRET_KEY` in the
Cloudflare Pages environment and the endpoint starts requiring a pass. Until
it is set the check is skipped entirely, so nothing breaks in the gap — the
same soft-required pattern the rest of the site uses.

Note the front-end widget is not on the form yet. Setting the secret **before**
the widget is added will reject every signup, so add the widget first, or set
the secret and immediately test a signup yourself.

---

## When you add a sending provider

Keep the list here and treat the provider as a transport, not as the
system of record. Concretely:

- Export at send time from D1 (above); do not maintain a second copy of the
  list inside the provider that can drift out of sync with your opt-outs.
- If the provider insists on holding the list, sync unsubscribes **back** into
  this table as well, or you will have two disagreeing opt-out states.
- Whatever you use, the `unsub_token` link above must survive into the sent
  message.

---

## Still outstanding

- **A retention period.** `privacy.html` carries a `TODO` where it should
  state how long subscribed and suppressed rows are kept. Publish a period
  only once something actually enforces it.
- **A welcome email**, if you want the guides delivered automatically rather
  than linked. Needs the provider above.
- **The Notion playbook URL.** `prop-firms.html` has a `data-playbook-url`
  attribute on `<section id="playbook">`, currently empty, which keeps that
  whole section hidden. Paste the shared Notion page URL in and it appears.
