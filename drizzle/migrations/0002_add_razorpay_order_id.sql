ALTER TABLE public.consultations
  ADD COLUMN IF NOT EXISTS razorpay_order_id text;

CREATE INDEX IF NOT EXISTS consultations_razorpay_order_id_idx
  ON public.consultations (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;