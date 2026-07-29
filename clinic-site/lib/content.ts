/**
 * All clinic content in one typed place.
 *
 * This is transcribed from `data/sample-personas/brightsmile-dental/*.md` — the same documents the
 * Replyo assistant retrieves over (RAG). Keeping them in sync matters: if the site
 * says whitening is ₹8,000 and the docs say something else, the chat widget will
 * confidently contradict the page it's sitting on. When you change a price or a
 * policy, change it in BOTH places.
 */

export const clinic = {
  name: "BrightSmile Dental",
  tagline: "Gentle, modern dentistry in Indiranagar",
  intro:
    "Check-ups, cleanings, whitening, implants and orthodontics — seven days a week, from a team that takes the time to explain everything before it happens.",
  address: {
    line1: "2nd Floor, Prestige Central",
    line2: "100 Feet Road, Indiranagar",
    city: "Bengaluru, Karnataka 560038",
    country: "India",
  },
  phone: "+91 80 4567 8900",
  email: "hello@brightsmile.example",
  parking: "Free patient parking, 2 hours validated",
  metro: "Indiranagar (Purple Line) — a 5-minute walk",
} as const;

export const hours = {
  rows: [
    { days: "Monday – Saturday", time: "9:30 AM – 8:00 PM" },
    { days: "Sunday", time: "10:00 AM – 2:00 PM" },
    { days: "Public holidays", time: "Reduced hours — please call ahead" },
  ],
  notes: [
    "We reserve emergency slots every day.",
    "The last routine appointment is booked one hour before closing.",
  ],
} as const;

export type Service = {
  title: string;
  blurb: string;
  items: string[];
};

export const services: Service[] = [
  {
    title: "General Dentistry",
    blurb:
      "Routine check-ups, cleanings, fillings and preventive care for the whole family. We recommend a check-up and cleaning every six months.",
    items: ["Routine check-ups", "Scaling & polishing", "Tooth-coloured fillings", "Preventive care"],
  },
  {
    title: "Cosmetic Dentistry",
    blurb: "Subtle, natural-looking work — whether that's a single shade brighter or a full smile makeover.",
    items: ["Teeth whitening (in-clinic & take-home)", "Composite veneers", "Porcelain veneers", "Smile makeovers"],
  },
  {
    title: "Restorative Dentistry",
    blurb: "Repairing and replacing teeth so they look and work like they should.",
    items: ["Tooth-coloured fillings", "Root canal treatment", "Crowns and bridges", "Dental implants"],
  },
  {
    title: "Orthodontics",
    blurb: "Straightening for teenagers and adults, with a plan mapped out before you commit.",
    items: ["Traditional metal braces", "Invisalign clear aligners", "Retainers"],
  },
  {
    title: "Paediatric Dentistry",
    blurb:
      "We welcome children from age 3. Our team is trained to make young patients feel at ease — visits are unhurried and explained in their language.",
    items: ["First visits from age 3", "Fluoride treatment", "Preventive care", "Gentle, unhurried appointments"],
  },
  {
    title: "Emergency Dental Care",
    blurb:
      "Same-day emergency slots are reserved daily for severe pain, swelling, broken teeth or knocked-out teeth. Call us as early as you can.",
    items: ["Severe pain or swelling", "Broken teeth", "Knocked-out teeth", "Same-day slots held daily"],
  },
];

export type PriceGroup = {
  group: string;
  rows: { item: string; price: string; note?: string }[];
};

/** Indicative starting prices in INR. Final costs are confirmed after an in-person consultation. */
export const pricing: PriceGroup[] = [
  {
    group: "Consultations & Diagnostics",
    rows: [
      { item: "New patient consultation", price: "₹500", note: "Waived if you proceed with treatment the same day" },
      { item: "Routine check-up", price: "₹400" },
      { item: "Dental X-ray (single)", price: "₹300" },
      { item: "Full-mouth X-ray (OPG)", price: "₹800" },
    ],
  },
  {
    group: "Cleaning & Hygiene",
    rows: [
      { item: "Scaling & polishing (standard cleaning)", price: "₹1,500" },
      { item: "Deep cleaning", price: "₹2,500", note: "Per quadrant" },
      { item: "Fluoride treatment", price: "₹800" },
    ],
  },
  {
    group: "Cosmetic",
    rows: [
      { item: "Teeth whitening (in-clinic)", price: "₹8,000", note: "Single session" },
      { item: "Take-home whitening kit", price: "₹5,000" },
      { item: "Composite veneer", price: "₹4,000", note: "Per tooth" },
      { item: "Porcelain veneer", price: "₹12,000", note: "Per tooth" },
    ],
  },
  {
    group: "Restorative",
    rows: [
      { item: "Composite filling", price: "₹1,000 – 2,500", note: "Depending on size" },
      { item: "Root canal treatment (front tooth)", price: "₹4,000" },
      { item: "Root canal treatment (molar)", price: "₹7,000" },
      { item: "Dental crown (porcelain/ceramic)", price: "₹9,000" },
      { item: "Dental implant", price: "₹35,000", note: "Single, including crown" },
    ],
  },
  {
    group: "Orthodontics",
    rows: [
      { item: "Braces (metal)", price: "from ₹40,000", note: "Full treatment" },
      { item: "Invisalign", price: "from ₹1,50,000", note: "Full treatment" },
    ],
  },
];

export const insurers = [
  "Star Health",
  "HDFC ERGO",
  "ICICI Lombard",
  "Niva Bupa",
  "Care Health Insurance",
] as const;

export const tpas = ["Medi Assist", "Paramount Health Services"] as const;

export type Policy = {
  title: string;
  body: string[];
};

export const policies: Policy[] = [
  {
    title: "Insurance",
    body: [
      "We are empanelled for cashless dental treatment (where your plan includes dental / OPD cover) with the insurers and TPAs listed above.",
      "If your insurer isn't listed, we can still provide a detailed invoice for you to claim reimbursement directly.",
      "Please bring your insurance / TPA card and a government photo ID (Aadhaar, PAN, or driving licence) to your appointment. Pre-authorisation may be required for treatments above ₹5,000.",
    ],
  },
  {
    title: "Cancellation & Rescheduling",
    body: [
      "Please give at least 24 hours' notice to cancel or reschedule an appointment.",
      "Late cancellations or no-shows may incur a ₹500 fee. Emergency situations are exempt.",
    ],
  },
  {
    title: "Payment",
    body: [
      "We accept cash, UPI, all major credit and debit cards, and bank transfer.",
      "No-cost EMI and payment plans are available for treatment plans above ₹20,000, subject to approval.",
    ],
  },
  {
    title: "New Patients",
    body: [
      "Please arrive 10 minutes early to complete a medical history form, or fill it in online via the link we send after booking.",
      "Bring a government photo ID (Aadhaar) and, if applicable, your insurance / TPA card.",
    ],
  },
  {
    title: "Privacy",
    body: [
      "Your medical and personal information is kept strictly confidential, and is only shared with your consent or as required by law.",
    ],
  },
];

export const nav = [
  { href: "/services", label: "Services" },
  { href: "/pricing", label: "Pricing" },
  { href: "/policies", label: "Patient info" },
  { href: "/contact", label: "Visit us" },
] as const;
