import { createFileRoute } from "@tanstack/react-router";

import { verifyAndConfirmConsultation } from "@/lib/razorpay.server";

type WebhookBody = {
  payload?: {
    payment?: { entity?: { order_id?: string } };
    order?: { entity?: { id?: string } };
  };
};

export const Route = createFileRoute("/api/public/razorpay-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: WebhookBody;
        try {
          body = (await request.json()) as WebhookBody;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const orderId = body.payload?.payment?.entity?.order_id ?? body.payload?.order?.entity?.id;
        if (!orderId || typeof orderId !== "string") {
          return Response.json({ ok: true });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: booking, error } = await supabaseAdmin
          .from("consultations")
          .select("*")
          .eq("razorpay_order_id", orderId)
          .maybeSingle();

        if (error) {
          console.error("Webhook consultation lookup failed:", error);
          return new Response("Lookup failed", { status: 500 });
        }
        if (!booking) return Response.json({ ok: true });

        try {
          await verifyAndConfirmConsultation(booking);
          return Response.json({ ok: true });
        } catch (err) {
          console.error("Webhook verify failed:", err);
          return new Response("Verification failed", { status: 500 });
        }
      },
    },
  },
});