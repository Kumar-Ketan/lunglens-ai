import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, CircleAlert, CircleCheck, CircleX, CreditCard, Download, FileText, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { downloadAppointmentPdf } from "@/lib/appointment-pdf";
import { formatInr, formatSlot } from "@/lib/consult";
import { cancelConsultation, confirmConsultationPayment, createRazorpayOrder } from "@/lib/consult.functions";
import { consultationQueryOptions, statusLabel, statusTone, type Consultation } from "@/lib/consultations";

type RazorpayInstance = {
  open: () => void;
  on: (event: string, cb: (res: { error?: { description?: string } }) => void) => void;
};

type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { name?: string; contact?: string };
  handler: () => void;
  modal?: { ondismiss?: () => void };
};

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

function loadRazorpayCheckout(): Promise<void> {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load Razorpay Checkout.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Razorpay Checkout."));
    document.body.appendChild(script);
  });
}

export const Route = createFileRoute("/_authenticated/consultations/$consultationId")({
  head: () => ({
    meta: [
      { title: "Consultation booking | LungScan AI" },
      { name: "description", content: "Pay for and manage your doctor consultation booking." },
      { property: "og:title", content: "Consultation booking | LungScan AI" },
      { property: "og:description", content: "Pay for and manage your doctor consultation booking." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: async ({ context, params }) => {
    const c = await context.queryClient.ensureQueryData(consultationQueryOptions(params.consultationId));
    if (!c) throw notFound();
  },
  notFoundComponent: () => (
    <section className="mx-auto max-w-3xl px-5 py-24 text-center">
      <h1 className="text-3xl font-semibold">Booking not found</h1>
      <Button asChild variant="glass" className="mt-6">
        <Link to="/consultations">My consultations</Link>
      </Button>
    </section>
  ),
  component: ConsultationPage,
});

function ConsultationPage() {
  const { consultationId } = Route.useParams();
  const { data } = useSuspenseQuery(consultationQueryOptions(consultationId));
  const booking = data as Consultation;

  return (
    <section className="mx-auto max-w-5xl px-5 py-12">
      <Button asChild variant="ghost" size="sm">
        <Link to="/consultations">
          <ArrowLeft aria-hidden="true" /> My consultations
        </Link>
      </Button>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        {booking.status === "pending_payment" ? (
          <PaymentPanel booking={booking} />
        ) : booking.status === "confirmed" ? (
          <ConfirmedPanel booking={booking} />
        ) : (
          <CancelledPanel booking={booking} />
        )}
        <BookingSummary booking={booking} />
      </div>
    </section>
  );
}

function useUpdateBooking() {
  const queryClient = useQueryClient();
  return (updated: Consultation) => {
    queryClient.setQueryData(consultationQueryOptions(updated.id).queryKey, updated);
    void queryClient.invalidateQueries({ queryKey: ["consultations"], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["consultations", "scan", updated.scan_id] });
  };
}

function PaymentPanel({ booking }: { booking: Consultation }) {
  const createOrder = useServerFn(createRazorpayOrder);
  const confirm = useServerFn(confirmConsultationPayment);
  const update = useUpdateBooking();
  const [busy, setBusy] = useState<null | "opening" | "verifying">(null);
  const [failure, setFailure] = useState<string | null>(null);
  const downloadedRef = useRef(false);

  const checkPayment = useCallback(async () => {
    setBusy("verifying");
    try {
      const updated = await confirm({ data: { consultationId: booking.id } });
      update(updated);
      if (updated.status === "confirmed" && !downloadedRef.current) {
        downloadedRef.current = true;
        toast.success("Payment received. Downloading your appointment PDF.");
        void downloadAppointmentPdf(updated).catch(() => {
          toast.error("Could not auto-download the PDF. Use the Download button below.");
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not check payment status.");
    } finally {
      setBusy(null);
    }
  }, [booking.id, confirm, update]);

  // Reconcile if the user already paid via UPI/redirect and returned to this page.
  useEffect(() => {
    if (booking.razorpay_order_id) void checkPayment();
  }, [booking.razorpay_order_id, checkPayment]);

  async function pay() {
    setFailure(null);
    setBusy("opening");
    try {
      const [order] = await Promise.all([
        createOrder({ data: { consultationId: booking.id } }),
        loadRazorpayCheckout(),
      ]);
      if (!window.Razorpay) throw new Error("Razorpay Checkout failed to load.");
      setBusy(null);

      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: "LungScan AI",
        description: `Consultation with ${booking.doctor_name}`,
        prefill: { name: booking.patient_name, contact: booking.patient_phone },
        handler: () => {
          void checkPayment();
        },
        modal: {
          ondismiss: () => {
            void checkPayment();
          },
        },
      });
      rzp.on("payment.failed", (res) => {
        setFailure(res.error?.description ?? "Payment did not go through. You can try again.");
      });
      rzp.open();
    } catch (e) {
      setBusy(null);
      toast.error(e instanceof Error ? e.message : "Could not start payment.");
    }
  }

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <CreditCard className="size-4 text-primary" aria-hidden="true" />
          <span className="font-semibold">Pay with Razorpay</span>
        </div>
        {booking.is_test_payment && (
          <span className="data rounded-full border border-pneumonia/40 bg-pneumonia/10 px-2.5 py-0.5 text-xs uppercase text-pneumonia">
            Test mode
          </span>
        )}
      </div>
      <div className="p-6 text-center">
        <p className="text-sm text-muted-foreground">Amount to pay</p>
        <p className="data mt-1 text-4xl font-semibold">{formatInr(booking.amount_paise)}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Pay by UPI, card, or netbanking via Razorpay Checkout.
        </p>

        {failure && (
          <p
            className="mx-auto mt-4 flex max-w-sm items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-left text-sm"
            role="alert"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            {failure}
          </p>
        )}

        <div className="mx-auto mt-6 flex max-w-sm flex-col gap-2">
          <Button variant="hero" onClick={pay} disabled={busy !== null}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <CreditCard aria-hidden="true" />}
            {busy === "opening"
              ? "Opening Razorpay…"
              : busy === "verifying"
                ? "Checking payment…"
                : `Pay ${formatInr(booking.amount_paise)} with Razorpay`}
          </Button>
        </div>

        <p className="mx-auto mt-6 flex max-w-sm items-start gap-2 text-left text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
          {booking.is_test_payment
            ? "Razorpay test mode is active. Use Razorpay test UPI, card, or netbanking details — no real money is debited."
            : "Payments are verified with Razorpay before your consultation is confirmed."}
        </p>
      </div>
    </div>
  );
}

function ConfirmedPanel({ booking }: { booking: Consultation }) {
  const [downloading, setDownloading] = useState(false);

  async function onDownloadPdf() {
    setDownloading(true);
    try {
      await downloadAppointmentPdf(booking);
    } catch {
      toast.error("Could not generate the appointment PDF.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="panel p-6">
      <span className="grid size-12 place-items-center rounded-full bg-normal/15 text-normal">
        <CircleCheck className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-2xl font-semibold sm:text-3xl">Consultation confirmed</h1>
      <p className="mt-2 text-muted-foreground">
        {booking.doctor_name} will see you on <span className="font-medium text-foreground">{formatSlot(booking.slot_at)}</span>{" "}
        (India time). The doctor will call {booking.patient_name} on +91 {booking.patient_phone}.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">
        Your X-ray, Grad-CAM heatmap and AI report have been shared with the doctor.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="hero" onClick={onDownloadPdf} disabled={downloading}>
          {downloading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          Download appointment PDF
        </Button>
        <Button asChild variant="glass">
          <Link to="/history/$scanId" params={{ scanId: booking.scan_id }}>
            <FileText aria-hidden="true" /> View the scan
          </Link>
        </Button>
        <CancelButton booking={booking} />
      </div>
    </div>
  );
}

function CancelledPanel({ booking }: { booking: Consultation }) {
  return (
    <div className="panel p-6">
      <span className="grid size-12 place-items-center rounded-full bg-secondary text-muted-foreground">
        <CircleX className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-2xl font-semibold sm:text-3xl">Booking cancelled</h1>
      <p className="mt-2 text-muted-foreground">
        {booking.paid_at ? "The test payment would be refunded." : "No payment was made."} You can book a new time any
        time.
      </p>
      <Button asChild variant="hero" className="mt-6">
        <Link to="/consult/$scanId" params={{ scanId: booking.scan_id }}>
          Book again
        </Link>
      </Button>
    </div>
  );
}

function CancelButton({ booking }: { booking: Consultation }) {
  const cancel = useServerFn(cancelConsultation);
  const update = useUpdateBooking();
  const [busy, setBusy] = useState(false);
  if (new Date(booking.slot_at).getTime() <= Date.now()) return null;

  async function onCancel() {
    setBusy(true);
    try {
      update(await cancel({ data: { consultationId: booking.id } }));
      toast.success("Booking cancelled");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not cancel the booking.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="glass" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null} Cancel booking
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this consultation?</AlertDialogTitle>
          <AlertDialogDescription>
            Your slot with {booking.doctor_name} will be released for other patients.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep booking</AlertDialogCancel>
          <AlertDialogAction onClick={onCancel}>Cancel booking</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function BookingSummary({ booking }: { booking: Consultation }) {
  const rows: [string, string][] = [
    ["Doctor", `${booking.doctor_name} · ${booking.specialty}`],
    ["When", `${formatSlot(booking.slot_at)} IST`],
    ["Patient", booking.patient_name],
    ["Mobile", `+91 ${booking.patient_phone}`],
    ["Reason", `${booking.detected_condition} detected`],
  ];
  if (booking.concern) rows.push(["Symptoms", booking.concern]);
  if (booking.payment_ref) rows.push(["Payment ref", booking.payment_ref]);
  if (booking.paid_at) rows.push(["Paid on", new Date(booking.paid_at).toLocaleString("en-IN")]);

  return (
    <aside className="panel self-start p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Booking details</h2>
        <span className={`data rounded-full border px-2.5 py-0.5 text-xs ${statusTone[booking.status] ?? ""}`}>
          {statusLabel[booking.status] ?? booking.status}
        </span>
      </div>
      <dl className="mt-4 space-y-3 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="shrink-0 text-muted-foreground">{k}</dt>
            <dd className="break-words text-right font-medium">{v}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
          <dt className="font-medium">
            {booking.status === "confirmed" ? (booking.is_test_payment ? "Paid (test)" : "Paid") : "Fee"}
          </dt>
          <dd className="data text-xl font-semibold">{formatInr(booking.amount_paise)}</dd>
        </div>
      </dl>
    </aside>
  );
}
