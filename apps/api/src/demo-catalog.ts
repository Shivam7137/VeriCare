// All people and administrative scenarios in this catalog are fictional.
export const demoPatients = [
  { id: "synthetic-patient-001", name: "Maya Chen" },
  { id: "demo-patient-jordan-brooks", name: "Jordan Brooks" },
  { id: "demo-patient-priya-shah", name: "Priya Shah" },
  { id: "demo-patient-oliver-reed", name: "Oliver Reed" },
  { id: "demo-patient-amara-okafor", name: "Amara Okafor" },
  { id: "demo-patient-lucas-martin", name: "Lucas Martin" },
  { id: "demo-patient-sofia-rivera", name: "Sofia Rivera" },
  { id: "demo-patient-noah-wilson", name: "Noah Wilson" },
  { id: "demo-patient-aisha-khan", name: "Aisha Khan" },
  { id: "demo-patient-ethan-park", name: "Ethan Park" },
] as const;

export const demoStaff = [
  { id: "synthetic-staff-001", name: "Dr. Anika Rao" },
  { id: "demo-staff-daniel-morris", name: "Dr. Daniel Morris" },
  { id: "demo-staff-elena-torres", name: "Elena Torres · Care coordinator" },
  { id: "demo-staff-grace-lee", name: "Grace Lee · Nurse coordinator" },
] as const;

export type DemoScenario = {
  key: string;
  patient: number;
  summary: string;
  stage: "verify" | "propose" | "review" | "confirm" | "complete" | "withdraw" | "handoff";
  revised?: boolean;
  rejected?: boolean;
  callbackChanged?: boolean;
  voice?: "pending" | "approved" | "handoff";
  callback?: boolean;
  failedDelivery?: boolean;
};

export const demoScenarios: readonly DemoScenario[] = [
  {
    key: "maya-follow-up",
    patient: 0,
    summary: "Follow-up visit after work",
    stage: "confirm",
    voice: "pending",
  },
  {
    key: "maya-annual-review",
    patient: 0,
    summary: "Annual review · afternoon preferred",
    stage: "review",
    revised: true,
  },
  {
    key: "maya-transport",
    patient: 0,
    summary: "Coordinate a visit with community transport",
    stage: "propose",
    rejected: true,
    callback: true,
  },
  {
    key: "maya-phone-booking",
    patient: 0,
    summary: "Routine check-in confirmed by phone",
    stage: "complete",
    voice: "approved",
  },
  {
    key: "maya-new-request",
    patient: 0,
    summary: "Move a morning visit around a work shift",
    stage: "verify",
  },
  {
    key: "maya-human-help",
    patient: 0,
    summary: "Ask a coordinator about two appointment options",
    stage: "handoff",
    voice: "handoff",
  },
  {
    key: "maya-withdrawn",
    patient: 0,
    summary: "Keep the original appointment after plans changed",
    stage: "withdraw",
  },
  {
    key: "maya-completed",
    patient: 0,
    summary: "Review appointment moved to a later time",
    stage: "complete",
    revised: true,
  },
  {
    key: "jordan-review",
    patient: 1,
    summary: "Earlier visit before an upcoming trip",
    stage: "review",
  },
  {
    key: "jordan-callback",
    patient: 1,
    summary: "Arrange an evening callback after work",
    stage: "propose",
    callbackChanged: true,
    callback: true,
  },
  {
    key: "priya-confirm",
    patient: 2,
    summary: "Follow-up visit outside school pickup time",
    stage: "confirm",
    callback: true,
  },
  {
    key: "priya-completed",
    patient: 2,
    summary: "Routine review moved to the preferred afternoon",
    stage: "complete",
    voice: "approved",
  },
  {
    key: "oliver-handoff",
    patient: 3,
    summary: "Coordinate accessible transport with the care team",
    stage: "handoff",
    voice: "handoff",
  },
  {
    key: "oliver-review",
    patient: 3,
    summary: "Longer travel time · later appointment requested",
    stage: "review",
    revised: true,
  },
  {
    key: "amara-proposal",
    patient: 4,
    summary: "Find a visit time after the morning shift",
    stage: "propose",
    callback: true,
  },
  {
    key: "amara-confirm",
    patient: 4,
    summary: "Confirm a revised follow-up time",
    stage: "confirm",
    revised: true,
  },
  {
    key: "lucas-completed",
    patient: 5,
    summary: "Return visit moved around a work meeting",
    stage: "complete",
  },
  {
    key: "lucas-verify",
    patient: 5,
    summary: "Check the appointment details before rescheduling",
    stage: "verify",
  },
  {
    key: "sofia-confirm",
    patient: 6,
    summary: "Try the callback again for a new appointment time",
    stage: "confirm",
    failedDelivery: true,
    callback: true,
  },
  {
    key: "sofia-review",
    patient: 6,
    summary: "Afternoon visit with a family member accompanying",
    stage: "review",
  },
  {
    key: "noah-completed",
    patient: 7,
    summary: "Follow-up booking confirmed after a second proposal",
    stage: "complete",
    revised: true,
  },
  {
    key: "noah-withdrawn",
    patient: 7,
    summary: "Original visit retained after transport was arranged",
    stage: "withdraw",
  },
  {
    key: "aisha-confirm",
    patient: 8,
    summary: "Review the proposed time before confirming",
    stage: "confirm",
    callback: true,
  },
  {
    key: "aisha-handoff",
    patient: 8,
    summary: "Request a coordinator to discuss scheduling options",
    stage: "handoff",
    voice: "handoff",
  },
  {
    key: "ethan-proposal",
    patient: 9,
    summary: "Choose a different time after the first offer",
    stage: "propose",
    rejected: true,
  },
  {
    key: "ethan-completed",
    patient: 9,
    summary: "Routine appointment moved to a convenient slot",
    stage: "complete",
    voice: "approved",
  },
];
