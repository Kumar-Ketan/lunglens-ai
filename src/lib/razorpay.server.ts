import type { Tables } from "@/integrations/supabase/types";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/razorpay";

function env(name: string) {
  return process.env[name];
}

export function razorpayEnv() {
  const lovableKey = env("LOVABLE_API_KEY");
  const connectionKey = env("RAZORPAY_CONNECTION_KEY");
  const keyId = env("RAZORPAY_CONNECTION_KEY_ID");
  if (!lovableKey || !connectionKey || !keyId) {
    throw new Error("Razorpay is not connected.");
  }
  return { lovableKey, connectionKey, keyId, live: keyId.startsWith("rzp_live_") };
}

export async function razorpayRequest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { lovableKey, connectionKey } = razorpayEnv();
  const response = await fetch(`${GATEWAY_URL}/${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": connectionKey,
      "Content-Type": "application/json",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    let description: string | undefined;
    try {
      description = (JSON.parse(text) as { error?: { description?: string } })?.error?.description;
    } catch {
      // raw body
    }
    console.error(`Razorpay ${path} failed [${response.status}]: ${text}`);
    throw new Error(description ?? `Razorpay request failed [${response.status}]`);
  }
  return (await response.json()) as T;
}

export type RazorpayOrder = {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: "created" | "attempted" | "paid";
};

type RazorpayPayment = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  method?: string;
};

type Consultation = Tables<"consultations">;

/**
 * Reads the Razorpay order from Razorpay and, only when Razorpay confirms payment
 * for the stored consultation fee, marks the consultation confirmed.
 */
export async function verifyAndConfirmConsultation(booking: Consultation): Promise<Consultation> {
  if (booking.status === "confirmed") return booking;
  if (booking.status !== "pending_payment") return booking;
  if (!booking.razorpay_order_id) return booking;

  const rzpOrder = await razorpayRequest<RazorpayOrder>(`orders/${booking.razorpay_order_id}`);
  let paymentId: string | null = null;
  let paymentMethod: string | null = null;
  let paid = rzpOrder.status === "paid" && rzpOrder.amount_paid === booking.amount_paise;

  if (paid || rzpOrder.status === "attempted") {
    const payments = await razorpayRequest<{ items: RazorpayPayment[] }>(
      `orders/${booking.razorpay_order_id}/payments`,
    );
    const captured = payments.items.find((p) => p.status === "captured");
    if (captured) {
      paymentId = captured.id;
      paymentMethod = captured.method ?? null;
    } else if (!paid) {
      const authorized = payments.items.find((p) => p.status === "authorized");
      if (authorized) {
        const cap = await razorpayRequest<RazorpayPayment>(`payments/${authorized.id}/capture`, {
          method: "POST",
          body: { amount: booking.amount_paise, currency: booking.currency },
        });
        if (cap.status === "captured" && cap.amount === booking.amount_paise) {
          paid = true;
          paymentId = cap.id;
          paymentMethod = cap.method ?? null;
        }
      }
    }
  }

  if (!paid) return booking;

  const { live } = razorpayEnv();
  const methodLabel = paymentMethod ? `Razorpay (${paymentMethod})` : "Razorpay";
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: updated, error } = await supabaseAdmin
    .from("consultations")
    .update({
      status: "confirmed",
      payment_method: live ? methodLabel : `${methodLabel} · test`,
      payment_ref: paymentId ?? booking.razorpay_order_id,
      paid_at: new Date().toISOString(),
      is_test_payment: !live,
    })
    .eq("id", booking.id)
    .eq("status", "pending_payment")
    .select("*")
    .maybeSingle();

  if (error?.code === "23505") {
    throw new Error("Someone else just booked this time. Please contact support for a refund.");
  }
  if (error) throw new Error("Could not save payment confirmation.");
  if (updated) return updated;

  // Concurrent webhook + client confirmation: return the already-updated row.
  const { data: latest } = await supabaseAdmin.from("consultations").select("*").eq("id", booking.id).maybeSingle();
  return latest ?? booking;
}