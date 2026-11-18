"use client";

import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import PitchLive from "./pitch-live";

export type SlideProps = { step: number; active: boolean; move: (direction: 1 | -1) => void };
type Slide = {
  id: string;
  tone: "paper" | "tint" | "dark";
  steps: number;
  time: string;
  notes: string[];
  Body: (props: SlideProps) => ReactNode;
};

const d = (index: number) => ({ "--d": index }) as CSSProperties;
const shown = (step: number, at: number) => (step >= at ? " in" : "");

// Each word rises out of its own mask when the slide becomes active.
function Words({ text, from = 0 }: { text: string; from?: number }) {
  return text.split(" ").map((word, index) => (
    <Fragment key={index}>
      <span className="pw">
        <span style={d(from + index)}>{word}</span>
      </span>{" "}
    </Fragment>
  ));
}

function Frame(props: {
  eyebrow: string;
  title: string;
  footer: string;
  page: number;
  aside?: string;
  narrow?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <p className="eyebrow r" style={d(0)}>
        {props.eyebrow}
      </p>
      {props.aside && (
        <p className="aside r" style={d(1)}>
          {props.aside}
        </p>
      )}
      <h2 className={`title${props.narrow ? " narrow" : ""}`}>
        <Words text={props.title} />
      </h2>
      {props.children}
      <p className="foot r" style={d(14)}>
        {props.footer}
      </p>
      <p className="page r" style={d(14)}>
        {props.page}/9
      </p>
    </>
  );
}

// Plays a slide's later beats on a timer, so each slide is one stream with no extra clicks.
function useAutoStep(active: boolean, last: number, wait: number, every = wait) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
    if (!active) return;
    const timers = Array.from({ length: last }, (_, index) =>
      setTimeout(() => setStep(index + 1), wait + index * every),
    );
    return () => timers.forEach(clearTimeout);
  }, [active, last, wait, every]);
  return active ? step : -1;
}

function useCountUp(target: number, active: boolean, decimals = 0) {
  const [value, setValue] = useState(target);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const started = performance.now() + 200;
    function tick(time: number) {
      const t = Math.min(1, Math.max(0, (time - started) / 800));
      const scale = 10 ** decimals;
      setValue(Math.round(target * (1 - Math.pow(1 - t, 4)) * scale) / scale);
      if (t < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, active]);
  return value.toLocaleString("en-CA", { minimumFractionDigits: decimals });
}

function TitleSlide() {
  return (
    <div className="cover">
      <p className="eyebrow r" style={d(0)}>
        HEALTHCARE · NOVA SCOTIA HEALTH
      </p>
      <h1 className="wordmark" aria-label="VeriCare">
        {"VeriCare".split("").map((letter, index) => (
          <span key={index} style={d(index)}>
            {letter}
          </span>
        ))}
      </h1>
      <p className="tagline">
        <Words
          text="No family should learn where a loved one is by waiting in a lobby."
          from={14}
        />
      </p>
      <p className="cover-foot r" style={d(16)}>
        Fast and Curious · Tribe AI Hackathon @ SMU · October 10, 2026
      </p>
    </div>
  );
}

const story = [
  [
    "OVERNIGHT",
    "An ambulance takes Jeremiah to emergency during a mental health crisis. At home, no phone rings.",
  ],
  [
    "AROUND 9 A.M.",
    "His parents get the call. They wait a few hours in the waiting room before they can see him.",
  ],
  [
    "AROUND 6:30 P.M.",
    "They learn he is already in a cab to a shelter, with no ID and no cellphone.",
  ],
  ["AFTERWARDS", "A follow-up is booked. No one tells his mother. He misses it."],
] as const;

function StorySlide({ active }: SlideProps) {
  const step = useAutoStep(active, 1, 1000);
  return (
    <Frame
      eyebrow="HALIFAX INFIRMARY · APRIL 2026"
      title="Jeremiah Dixon was 19 and in crisis. His parents say the first call came the next morning."
      footer="Source: news report carried by Yahoo News Canada (2026). Times and events as described by his parents."
      page={2}
    >
      <div className="columns story">
        {story.map(([label, body], index) => (
          <div className={`column seq${index === 3 ? " amber" : ""}`} key={label} style={d(index)}>
            <i className="rule" />
            <p className="label">{label}</p>
            <p className="body">{body}</p>
          </div>
        ))}
      </div>
      <div className={`pair st${shown(step, 1)}`}>
        <p>No one was careless. His family had no reliable way to ask.</p>
        <p>And the staff on shift had no safe, tracked way to answer.</p>
      </div>
    </Frame>
  );
}

const how = [
  ["01 · Before anything happens", "Named once", "The patient names up to two trusted contacts."],
  [
    "02 · Something changes",
    "Picked up from the feed",
    "Registration, imaging, a new unit. Read from the hospital's location feed.",
  ],
  [
    "03 · Verify",
    "Who is this, and may they know?",
    "Identity and authority are checked separately. A matching phone number is not permission.",
  ],
  [
    "04 · Release",
    "Only what policy allows",
    "Presence, location, general condition. Answered at any hour, and sent unprompted when something changes.",
  ],
] as const;

function HowSlide({ active }: SlideProps) {
  const step = useAutoStep(active, 1, 1000);
  return (
    <Frame
      eyebrow="HOW VERICARE WORKS"
      title="It runs the hospital's own release protocol, so staff don't have to at 3 a.m."
      footer="Two named contacts mirrors Nova Scotia Health's Family Presence Policy. Disclosure limits follow its privacy statement and PHIA."
      page={3}
    >
      <div className="columns how">
        {how.map(([label, head, body], index) => (
          <div className="column seq" key={label} style={d(index)}>
            <i className="rule" />
            <p className="label plain">{label}</p>
            <h3>{head}</h3>
            <p className="body">{body}</p>
          </div>
        ))}
      </div>
      <div className={`pair once st${shown(step, 1)}`}>
        <p>Anything more goes to a person. Once.</p>
        <p className="body">
          A discharge plan, a procedure, hard news: the clinician gets a single prompt with the
          verified contact attached.
        </p>
      </div>
    </Frame>
  );
}

const texts = [
  {
    label: "11:52 P.M. · REGISTERED",
    head: "Arrives in Emergency",
    body: "The location feed shows a new registration.",
    time: "11:52 PM",
    message: "Sam has arrived at the Halifax Infirmary Emergency Department.",
  },
  {
    label: "2:10 A.M. · MOVED",
    head: "Taken to imaging",
    body: "A change of unit. Nobody has to remember to phone.",
    time: "2:10 AM",
    message: "Sam has moved to Diagnostic Imaging. Reply WHERE at any time.",
  },
  {
    label: "4:45 P.M. · DISCHARGE PLANNED",
    head: "Getting ready to leave",
    body: "The family hears before the cab is called, not after.",
    time: "4:45 PM",
    message: "Sam is getting ready to leave. A nurse will call you first.",
    amber: true,
  },
];

function SmsSlide({ active }: SlideProps) {
  const step = useAutoStep(active, 2, 1300, 1100);
  return (
    <Frame
      eyebrow="PROACTIVE UPDATES · SMS"
      title="When something changes, VeriCare texts the family first."
      footer="Illustrative messages for a fictional patient. Texts carry presence, location and general condition only."
      page={4}
      narrow
    >
      {texts.map((item, index) => (
        <div
          className={`event st${shown(step, index)}${item.amber ? " amber" : ""}`}
          key={item.label}
          style={{ top: 300 + index * 150 }}
        >
          <p className="label">{item.label}</p>
          <h3>{item.head}</h3>
          <p className="body">{item.body}</p>
          <i className="wire" />
        </div>
      ))}
      <div className="phone-wrap r" style={d(4)}>
        <div
          className="phone"
          style={{ animationName: step < 0 ? "none" : `pitchBuzz${step % 2}` }}
        >
          <div className="phone-screen">
            <i className="phone-notch" />
            <div className="phone-head">
              <b>CB</b>
              <div>
                <strong>VeriCare</strong>
                <span>Halifax Infirmary · Text message</span>
              </div>
            </div>
            {texts.map((item, index) => (
              <div
                className={`sms st${shown(step, index)}${item.amber ? " amber" : ""}`}
                key={item.time}
                style={{ top: 212 + index * 150 }}
              >
                <p className="sms-top">
                  <i />
                  <strong>VeriCare</strong>
                  <time>{item.time}</time>
                </p>
                <p>{item.message}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Frame>
  );
}

const jobs = [
  [
    "PATIENT FLOW",
    "Call the porter",
    "A patient is marked ready to transfer.",
    "Pages a porter, confirms pickup and tells the receiving unit.",
    "Nurses stop phoning dispatch.",
  ],
  [
    "APPOINTMENTS",
    "Remind before the day",
    "An appointment is two days away.",
    "Texts the patient and their named contact to confirm.",
    "The family hears about it too.",
  ],
  [
    "REBOOKING",
    "Reschedule by text",
    "Someone replies that they cannot make it.",
    "Offers the next open times and frees the old slot.",
    "Fewer missed scans each year.",
  ],
] as const;

function NextSlide() {
  return (
    <Frame
      eyebrow="WHAT COMES NEXT"
      title="Family updates are the first job. The same loop can take on the next ones."
      footer="Roadmap, not yet built. Each job reuses the same verify, authorize, notify and log steps."
      page={5}
    >
      <div className="jobs">
        {jobs.map(([label, head, when, does, result], index) => (
          <div className="job seq" key={label} style={d(index)}>
            <p className="label spaced">{label}</p>
            <h3>{head}</h3>
            <div className="when">
              <span>WHEN</span>
              <p>{when}</p>
            </div>
            <i className="drop" />
            <div className="does">
              <span>VERICARE</span>
              <p>{does}</p>
            </div>
            <p className="result">{result}</p>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function BigPictureSlide({ active }: SlideProps) {
  const visits = useCountUp(561556, active);
  return (
    <Frame
      eyebrow="THE BIG PICTURE"
      aside="Fast & Curious · Tribe AI Hackathon @ SMU"
      title="One layer between the hospital's systems and the family waiting to hear."
      footer="Figure: Nova Scotia Health 2024/25 Annual Report. Prototype only, with no integration or endorsement claimed."
      page={6}
    >
      <div className="figures">
        <div className="r" style={d(3)}>
          <p className="stat">{visits}</p>
          <p className="small">
            emergency visits at Nova Scotia Health in 2024/25. Each one has someone waiting to hear.
          </p>
        </div>
        <div className="r" style={d(5)}>
          <p className="stat">Up to 2</p>
          <p className="small">
            trusted contacts named by each patient. They are the people VeriCare answers.
          </p>
        </div>
        <div className="next-test r" style={d(7)}>
          <i className="rule" />
          <p className="label plain">Next test</p>
          <p className="small ink">
            One Halifax ED, nights and weekends: count &quot;where is my family member?&quot; calls
            per shift.
          </p>
        </div>
      </div>
      <div className="layers">
        <div className="layer top">
          <p>What a family needs to know</p>
          <div className="chips">
            {[
              "Are they here?",
              "Where are they now?",
              "How are they doing?",
              "What happens next?",
            ].map((chip, index) => (
              <span key={chip} style={d(index)}>
                {chip}
              </span>
            ))}
          </div>
        </div>
        <div className="layer bridge">
          <strong>VeriCare</strong>
          <b>Verify · Authorize · Notify · Log</b>
          <p>Answered at any hour, and texted before they have to ask.</p>
        </div>
        <div className="layer bottom">
          <p>Systems the hospital already runs</p>
          <div className="chips">
            {["Location feed", "Patient record", "Phone and SMS", "Audit log"].map(
              (chip, index) => (
                <span key={chip} style={d(index)}>
                  {chip}
                </span>
              ),
            )}
          </div>
        </div>
      </div>
    </Frame>
  );
}

function ImpactSlide({ active }: SlideProps) {
  const offload = useCountUp(195, active);
  const hours = useCountUp(7000, active);
  const canada = useCountUp(15.6, active, 1);
  return (
    <Frame
      eyebrow="THE IMPACT"
      title="Hours a family spends not knowing. Hours staff spend on the phone."
      footer="Sources: N.S. Auditor General (2023); Province of N.S. (2021); N.S. ED Accountability Report 2023-24; CIHI. Hours and price are estimates."
      page={7}
    >
      <div className="impact">
        <div className="impact-card seq" style={d(0)}>
          <p className="label spaced">BY AMBULANCE</p>
          <p className="stat">About 1 in 4</p>
          <p className="small">patients at the Halifax Infirmary ED arrive by ambulance.</p>
          <p className="stat second">{offload} min</p>
          <p className="small">
            average ambulance offload delay there in 2022. Over three hours in which a family may
            hear nothing.
          </p>
        </div>
        <div className="impact-card teal seq" style={d(1)}>
          <p className="label spaced">TIME BACK TO STAFF</p>
          <p className="stat">≈ {hours}</p>
          <p className="small">
            staff hours a year across Nova Scotia now spent answering &quot;where are they?&quot;
          </p>
          <p className="assume">
            Estimate: one visit in four leads to one 3-minute call. Our next test measures the real
            number.
          </p>
        </div>
        <div className="impact-card seq" style={d(2)}>
          <p className="label spaced">WHO IT REACHES</p>
          <div className="reach">
            <p style={{ width: "34%" }}>
              <b>75,053</b>
              <span>Halifax Infirmary · first site</span>
            </p>
            <p style={{ width: "62%" }}>
              <b>561,556</b>
              <span>Nova Scotia Health</span>
            </p>
            <p style={{ width: "100%" }}>
              <b>{canada} million</b>
              <span>Canada</span>
            </p>
          </div>
          <p className="small">
            emergency visits a year. At an illustrative $1 a visit, about $15.6M a year nationally.
          </p>
        </div>
      </div>
    </Frame>
  );
}

function ClosingSlide({ active }: SlideProps) {
  const step = useAutoStep(active, 3, 800, 550);
  return (
    <div className="closing">
      <p className="eyebrow r" style={d(0)}>
        WHY WE BUILT IT THIS WAY
      </p>
      <h2 className="headline">
        <Words text="On your worst day, the last thing you need is a system to fight." from={2} />
      </h2>
      <div className="closing-pair">
        <p className={`st${shown(step, 1)}`}>
          A family in distress is already carrying enough. A generic, half-finished system hands
          them one more thing to work out.
        </p>
        <p className={`reply st${shown(step, 2)}`}>
          VeriCare is built the other way round. It comes to them, in plain words, on the phone they
          already have.
        </p>
      </div>
      <p className={`promise st${shown(step, 3)}`}>
        <i />
        Empathy is the design, not a feature.
      </p>
      <p className="foot">VeriCare · Thank you</p>
      <p className="page">8/9</p>
    </div>
  );
}

function LiveSlide({ step, active, move }: SlideProps) {
  const open = step >= 1;
  return (
    <>
      <div className={`live-intro${open ? " gone" : ""}`}>
        <p className="eyebrow r" style={d(0)}>
          <i className="live-pulse" /> LIVE DEMO
        </p>
        <h2 className="headline">
          <Words text="Now, a real call." from={2} />
        </h2>
        <p className="live-lede r" style={d(7)}>
          A fictional patient, a real phone line. Watch what VeriCare hears, what it checks, and
          what it sends.
        </p>
        <button className="live-open r" style={d(9)} onClick={() => move(1)}>
          Open the live panel <span>→</span>
        </button>
      </div>
      <PitchLive open={open} polling={active} onClose={() => move(-1)} onLive={() => move(1)} />
    </>
  );
}

export const slides: Slide[] = [
  {
    id: "cover",
    tone: "paper",
    steps: 0,
    time: "0:00 to 0:08",
    notes: ["We are VeriCare. No family should learn where a loved one is by waiting in a lobby."],
    Body: TitleSlide,
  },
  {
    id: "story",
    tone: "tint",
    steps: 0,
    time: "0:08 to 0:40",
    notes: [
      "Jeremiah Dixon was 19. In April an ambulance took him to the Halifax Infirmary in a mental health crisis. Overnight, no phone rang at home.",
      "His parents got the call around nine the next morning. By 6:30 that evening he was in a cab to a shelter, with no ID and no phone.",
      "Nobody was careless. His family had no reliable way to ask, and staff had no safe, tracked way to answer.",
    ],
    Body: StorySlide,
  },
  {
    id: "how",
    tone: "paper",
    steps: 0,
    time: "0:40 to 1:10",
    notes: [
      "VeriCare runs the hospital's own release protocol. The patient names up to two trusted contacts. When something changes, VeriCare reads it from the hospital's location feed.",
      "It checks who is asking and whether they may know, as two separate checks. Then it releases only what policy allows: presence, location, general condition.",
      "Anything more goes to a clinician, once.",
    ],
    Body: HowSlide,
  },
  {
    id: "sms",
    tone: "tint",
    steps: 0,
    time: "1:10 to 1:32",
    notes: [
      "And the family should not have to ask. When something changes, VeriCare texts them first.",
      "Arrived in Emergency. Moved to imaging. Getting ready to leave, and a nurse will call. Plain text messages, no app, each one logged.",
    ],
    Body: SmsSlide,
  },
  {
    id: "next",
    tone: "paper",
    steps: 0,
    time: "1:32 to 1:52",
    notes: [
      "Family updates are the first job. The same loop can page a porter when a patient is ready to move, remind the patient and their contact about an appointment, and reschedule by text.",
      "None of that is built yet.",
    ],
    Body: NextSlide,
  },
  {
    id: "big",
    tone: "paper",
    steps: 0,
    time: "1:52 to 2:12",
    notes: [
      "Nova Scotia Health saw 561,556 emergency visits in 2024/25. Each one has a family asking the same four questions.",
      "The hospital already holds the answers. VeriCare is the one layer in between.",
    ],
    Body: BigPictureSlide,
  },
  {
    id: "impact",
    tone: "tint",
    steps: 0,
    time: "2:12 to 2:40",
    notes: [
      "About one in four patients at the Halifax Infirmary arrive by ambulance, and the average offload delay there was 195 minutes in 2022. That is three hours of a family not knowing.",
      "We estimate about 7,000 staff hours a year go to these calls in Nova Scotia. Our next test, in one Halifax emergency department, measures the real number.",
    ],
    Body: ImpactSlide,
  },
  {
    id: "closing",
    tone: "paper",
    steps: 0,
    time: "2:40 to 3:00",
    notes: [
      "One last thing, and it is the reason we built this. On your worst day, the last thing you need is a system to fight.",
      "A family in distress is already carrying enough. A generic, half-finished system hands them one more thing to work out.",
      "VeriCare is built the other way round. It comes to them, in plain words, on the phone they already have.",
      "Empathy is not a feature we added. It is the design. Thank you.",
    ],
    Body: ClosingSlide,
  },
  {
    id: "live",
    tone: "dark",
    steps: 1,
    time: "Live demo · one click opens the panel",
    notes: [
      "Place the call to the demo line. The panel opens by itself as soon as the call connects, or click to open it first.",
      "The caller's words appear on the left as they are transcribed, with Alex's replies beside them.",
      "On the right is every step VeriCare takes: matching the patient, texting a verification code to the registered contact, checking the code, and only then releasing the location.",
      "If the call does not connect, use Show the last recorded call.",
    ],
    Body: LiveSlide,
  },
];
