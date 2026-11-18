<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules

- The ResNet18 TB model runs in the browser (ONNX); the server never runs it. Why: keeps the model free to host and works on edge workers.
- The AI second opinion runs only in an authenticated server function that reads the user's own X-ray and writes results onto that scan row. Why: keeps the AI key server-side and RLS scoped to the owner.
- Scan pages live under `_authenticated/history.*` as flat routes (no `history.tsx` layout). Why: avoids a layout that must render an Outlet.
- Consultation bookings are created, paid and cancelled only through authenticated server functions; users have read-only access to their own rows. Why: nobody can mark a booking paid from the browser, and the demo payment step can later be swapped for a real gateway check.
