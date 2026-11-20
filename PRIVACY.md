# Inbox Broom privacy policy

Inbox Broom has no server and the developer receives no data, analytics or telemetry.

## What the extension reads

On `mail.google.com` it reads what the Gmail page shows: sender, subject, the short preview Gmail displays, labels, dates and your Manage subscriptions page. It uses this to run your rules and to show the review page.

## Where data is stored

Settings, rules, cached verdicts, the activity log and any API key you enter are kept in the extension's local storage in your browser. Nothing is synced. Removing the extension deletes them.

## What leaves your machine

- **Ollama (default):** nothing. Requests go to the Ollama server on your own computer (`localhost:11434`).
- **OpenAI-compatible or Anthropic provider (opt-in):** only if you choose one in Settings. For each mail being triaged, the sender, subject and about 200 characters of the preview are sent to the endpoint you configured, together with your own API key. Firefox asks you to allow this ("personal communications") before anything is sent, and you can revoke it in `about:addons` → Inbox Broom → Permissions. That provider's own privacy policy applies to what it receives.
- **Unsubscribe:** clicking Gmail's Unsubscribe makes Gmail contact the sender, as it would if you clicked it yourself.

## Contact

Issues and questions: <https://github.com/shivangrathore/inboxbroom/issues>
