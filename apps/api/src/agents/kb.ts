// Curated, non-clinical answers the Visit Agent may give word for word.
// The agent picks an article; it never writes or edits the answer.
// Facility details are fictional and belong to the demo hospital.

export type KbArticle = { id: string; title: string; body: string };

export const kbArticles: readonly KbArticle[] = [
  {
    id: "phone_charging",
    title: "Charging a phone",
    body: "There are free charging lockers beside the registration desk, and outlets along the window wall of the waiting room. The desk can lend a cable.",
  },
  {
    id: "parking",
    title: "Parking and paying for parking",
    body: "The closest parking is the Robie Street parkade. Pay at the machine in the lobby before you return to your car. If your visit runs long, ask registration about the daily maximum.",
  },
  {
    id: "visitors",
    title: "Who can wait with a patient",
    body: "One support person can wait with you in the waiting room. Once you are in a treatment room, the nurse will tell you how many people can join you.",
  },
  {
    id: "food_and_drink",
    title: "Eating and drinking while waiting",
    body: "Please ask the triage nurse before you eat or drink, because some tests need an empty stomach. There is a water station and a cafe past the main lobby for the people with you.",
  },
  {
    id: "washrooms",
    title: "Washrooms",
    body: "Washrooms are at the back of the waiting room, to the left of the vending machines. Tell the triage nurse if you need help getting there.",
  },
  {
    id: "wait_order",
    title: "Why other people are seen first",
    body: "The team sees the sickest patients first, not the people who arrived first. That is why someone who came after you may go in before you, and why your estimate can change.",
  },
  {
    id: "triage_levels",
    title: "What triage means",
    body: "A triage nurse checks everyone who arrives and decides how soon each person needs to be seen. If you start to feel worse while you wait, tell the triage nurse right away.",
  },
  {
    id: "wifi",
    title: "Wi-Fi",
    body: "Free Wi-Fi is available on the network named NSHealth-Guest. No password is needed.",
  },
  {
    id: "stepping_out",
    title: "Stepping outside for a moment",
    body: "Please tell the triage nurse before you step out, even for a few minutes, so you are not missed when your name is called.",
  },
  {
    id: "how_updates_work",
    title: "How these updates work",
    body: "These updates come from the hospital's own record of your visit. You will hear when your step changes or your estimate moves. You can type STATUS at any time, and you can add a family member so they get updates too.",
  },
];

export const kbArticle = (id: string) => kbArticles.find((article) => article.id === id) ?? null;
