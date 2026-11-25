import { CONSULT_TIMEZONE, formatSlot } from "@/lib/consult";
import type { Consultation } from "@/lib/consultations";

/** ASCII-safe INR amount for jsPDF's built-in Helvetica font (which lacks the ₹ glyph). */
export function formatPdfInr(paise: number): string {
  const rupees = paise / 100;
  return `INR ${Number.isInteger(rupees) ? rupees.toString() : rupees.toFixed(2)}`;
}

export function appointmentPdfFilename(consultationId: string): string {
  return `lungscan-appointment-${consultationId.slice(0, 8)}.pdf`;
}

function formatIstDateTime(iso: string): string {
  return `${new Intl.DateTimeFormat("en-IN", {
    timeZone: CONSULT_TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso))} IST`;
}

/** Builds and downloads a one-page A4 appointment confirmation & payment receipt PDF. */
export async function downloadAppointmentPdf(booking: Consultation): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 18;
  const contentW = W - 2 * M;

  // Header band
  doc.setFillColor(18, 28, 40);
  doc.rect(0, 0, W, 32, "F");
  doc.setTextColor(120, 220, 235);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text("LungScan AI", M, 14);
  doc.setTextColor(225, 235, 245);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text("Doctor Consultation Appointment Confirmation & Receipt", M, 22);

  // Status pill on header right
  const badgeText = booking.is_test_payment ? "CONFIRMED (TEST)" : "CONFIRMED";
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  const badgeW = doc.getTextWidth(badgeText) + 10;
  doc.setFillColor(24, 130, 92);
  doc.roundedRect(W - M - badgeW, 10, badgeW, 8, 2, 2, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(badgeText, W - M - badgeW / 2, 15.3, { align: "center" });

  let y = 44;

  // Highlighted appointment slot box
  doc.setFillColor(243, 247, 251);
  doc.setDrawColor(214, 224, 235);
  doc.roundedRect(M, y, contentW, 30, 3, 3, "FD");

  doc.setTextColor(95, 110, 128);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("APPOINTMENT SCHEDULE", M + 6, y + 8);

  doc.setTextColor(18, 28, 40);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(booking.doctor_name, M + 6, y + 16);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(60, 72, 88);
  doc.text(`${booking.specialty}  |  ${formatSlot(booking.slot_at)} (India Time)`, M + 6, y + 23);

  y += 40;

  const drawSection = (title: string, rows: [string, string][]) => {
    doc.setTextColor(18, 28, 40);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(title, M, y);
    y += 3;
    doc.setDrawColor(220, 228, 236);
    doc.line(M, y, W - M, y);
    y += 7;

    doc.setFontSize(9.5);
    for (const [label, value] of rows) {
      doc.setFont("helvetica", "bold");
      doc.setTextColor(90, 102, 116);
      doc.text(label, M, y);

      doc.setFont("helvetica", "normal");
      doc.setTextColor(25, 32, 42);
      const wrapped = doc.splitTextToSize(value, contentW - 48);
      doc.text(wrapped, M + 48, y);
      y += Math.max(wrapped.length, 1) * 5 + 2.5;
    }
    y += 4;
  };

  const patientRows: [string, string][] = [
    ["Booking ID", booking.id],
    ["Patient Name", booking.patient_name],
    ["Mobile Number", `+91 ${booking.patient_phone}`],
    ["Detected Finding", `${booking.detected_condition} detected`],
    ["Linked Scan ID", booking.scan_id],
  ];
  if (booking.concern) {
    patientRows.push(["Symptoms / Notes", booking.concern]);
  }
  drawSection("1. Patient & Consultation Details", patientRows);

  const paymentRows: [string, string][] = [
    ["Consultation Fee", formatPdfInr(booking.amount_paise)],
    ["Payment Status", booking.is_test_payment ? "Paid (Razorpay Test Mode - no real money debited)" : "Paid"],
    ["Payment Method", booking.payment_method ?? "Razorpay"],
    ["Payment Reference", booking.payment_ref ?? "-"],
  ];
  if (booking.razorpay_order_id) {
    paymentRows.push(["Razorpay Order ID", booking.razorpay_order_id]);
  }
  if (booking.paid_at) {
    paymentRows.push(["Paid On", formatIstDateTime(booking.paid_at)]);
  }
  drawSection("2. Payment Receipt", paymentRows);

  // Next steps callout
  doc.setFillColor(246, 250, 248);
  doc.setDrawColor(198, 226, 212);
  const noteText =
    `Next steps: ${booking.doctor_name} will call ${booking.patient_name} on +91 ${booking.patient_phone} at the scheduled time. ` +
    "Your chest X-ray, Grad-CAM heatmap, and AI report have been linked to this consultation.";
  const noteLines = doc.splitTextToSize(noteText, contentW - 12);
  const boxH = noteLines.length * 4.8 + 10;
  doc.roundedRect(M, y, contentW, boxH, 2.5, 2.5, "FD");
  doc.setTextColor(30, 82, 58);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(noteLines, M + 6, y + 7);

  // Footer disclaimer
  doc.setDrawColor(230, 235, 240);
  doc.line(M, 274, W - M, 274);
  doc.setFontSize(7.5);
  doc.setTextColor(120, 128, 138);
  const disclaimer = doc.splitTextToSize(
    "LungScan AI is an academic prototype for chest X-ray screening and consultation booking. " +
      "This receipt confirms your scheduled consultation; for medical emergencies, contact local emergency services immediately.",
    contentW,
  );
  doc.text(disclaimer, M, 279);

  doc.save(appointmentPdfFilename(booking.id));
}