/**
 * Fill a development database with the sample dictations, terms and chats the
 * guide figures show.
 *
 * The figures are screenshots of the running app, so a figure with real
 * content needs a database that holds some. This writes only into an empty
 * database and refuses one that already has transcriptions, so it can never
 * touch a person's own history.
 *
 * Usage:
 *   node apps/docs/scripts/seed-guide-data.mjs [--db <path>]
 *
 * The default path is the Linux location the debug build uses. Quit the app
 * before running it: the app holds the database open.
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const defaultDb = join(
  homedir(),
  ".config",
  "com.mausinc.desktop",
  "mausvoice.db",
);

const day = 24 * 60 * 60 * 1000;
const at = (origin, daysAgo, hour) => {
  const date = new Date(origin - daysAgo * day);
  date.setHours(hour, 12, 0, 0);
  return date.getTime();
};

const localDate = (ms) => {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
};

const transcriptions = [
  {
    daysAgo: 0,
    hour: 9,
    words: 42,
    text: "Send Priya the revised onboarding copy before the design review, and move the billing question to Thursday so Marcus can join.",
  },
  {
    daysAgo: 0,
    hour: 14,
    words: 26,
    text: "Note for the release checklist: the Windows installer needs the new sidebar art before the tag.",
  },
  {
    daysAgo: 1,
    hour: 11,
    words: 61,
    text: "The dictation latency on the last build felt worse on the laptop. Worth checking whether the model reload happens on every session or only after an idle timeout, because the first dictation after launch is the slow one.",
  },
  {
    daysAgo: 1,
    hour: 17,
    words: 18,
    text: "Reply to the customer in the EU thread: audio never leaves the device when local transcription is selected.",
  },
  {
    daysAgo: 2,
    hour: 10,
    words: 34,
    text: "Draft the changelog entry for 0.1.6. Lead with the review panel, then the dictionary import, then the pill placement options.",
  },
  {
    daysAgo: 3,
    hour: 15,
    words: 48,
    text: "Two things from today's support calls. People expect the pill to stay where they drag it across restarts, and they look for the hotkey under Settings rather than in the tray menu.",
  },
  {
    daysAgo: 4,
    hour: 9,
    words: 21,
    text: "Ask the docs team whether the troubleshooting page should mention the microphone permission prompt on macOS.",
  },
  {
    daysAgo: 6,
    hour: 13,
    words: 55,
    text: "The dictionary should treat product names as one term, so mausVoice, Whisper and Deepgram each get an entry rather than relying on the model to guess the spelling every time.",
  },
  {
    daysAgo: 8,
    hour: 16,
    words: 12,
    text: "Book the room for the release retro on the ninth.",
  },
];

const terms = [
  ["maus voice", "mausVoice"],
  ["mausvoice", "mausVoice"],
  ["whisper cpp", "whisper.cpp"],
  ["deep gram", "Deepgram"],
  ["sherpa onnx", "sherpa-onnx"],
  ["web kit", "WebKit"],
];

const conversation = {
  title: "Release notes for 0.1.6",
  messages: [
    ["user", "Summarise this week's dictation notes into three release-note bullets."],
    [
      "assistant",
      "Here are three bullets drawn from this week's notes:\n\n- The review panel now shows the pending paste before it reaches the field.\n- Dictionary import accepts a CSV so existing term lists carry over.\n- Pill placement can be set per display, and the choice survives a restart.",
    ],
    ["user", "Tighten the second bullet. It should say what a person gains, not what the code does."],
    [
      "assistant",
      "Revised:\n\n- Existing term lists carry over, so a new install keeps the names it already knows.\n\nThe other two bullets are unchanged.",
    ],
  ],
};

const insertSampleTranscriptions = (db, origin) => {
  const insert = db.prepare(
    `INSERT INTO transcriptions (id, transcript, timestamp, raw_transcript, transcription_mode, post_process_mode, model_size, transcription_duration_ms)
     VALUES (?, ?, ?, ?, 'local', 'none', 'small', ?)`,
  );
  for (const entry of transcriptions) {
    const timestamp = at(origin, entry.daysAgo, entry.hour);
    insert.run(
      `guide-${timestamp}`,
      entry.text,
      timestamp,
      entry.text,
      900 + entry.words * 12,
    );
  }
};

/** Two quiet days keep the streak honest, and a slow wave gives the grid its variation. */
const SILENT_DAYS = new Set([23, 41]);

const wordsForDay = (origin, daysAgo) => {
  const date = new Date(origin - daysAgo * day);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const wave = Math.round(40 * Math.sin((69 - daysAgo) / 6));
  return Math.max(18, (weekend ? 40 : 90) + wave + ((daysAgo * 37) % 90));
};

/** Ten weeks of activity, so the heatmap shows the variation a real history has. */
const insertDailyActivity = (db, origin) => {
  const insert = db.prepare(
    `INSERT INTO daily_word_activity (local_date, word_count) VALUES (?, ?)
     ON CONFLICT(local_date) DO UPDATE SET word_count = excluded.word_count`,
  );
  const daily = new Map();
  for (let daysAgo = 69; daysAgo >= 0; daysAgo -= 1) {
    if (SILENT_DAYS.has(daysAgo)) continue;
    const date = localDate(origin - daysAgo * day);
    daily.set(date, wordsForDay(origin, daysAgo));
    insert.run(date, daily.get(date));
  }
  return daily;
};

const profileTotals = (daily, origin) => {
  const total = [...daily.values()].reduce((sum, words) => sum + words, 0);
  const month = localDate(origin).slice(0, 7);
  const monthTotal = [...daily]
    .filter(([date]) => date.startsWith(month))
    .reduce((sum, [, words]) => sum + words, 0);
  let streak = 0;
  while (daily.has(localDate(origin - streak * day))) streak += 1;
  return { total, month, monthTotal, streak };
};

const insertProfile = (db, totals, origin) => {
  db.prepare(
    `INSERT INTO user_profiles (id, name, bio, onboarded) VALUES ('local-user-id', 'Alex', '', 1)
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO user_preferences (user_id) VALUES ('local-user-id')
     ON CONFLICT(user_id) DO NOTHING`,
  ).run();
  db.prepare(
    `UPDATE user_profiles
        SET words_total = ?, words_this_month = ?, words_this_month_month = ?,
            streak = ?, streak_recorded_at = ?, name = 'Alex', onboarded = 1,
            has_finished_tutorial = 1, onboarded_at = ?
      WHERE id = (SELECT id FROM user_profiles LIMIT 1)`,
  ).run(
    totals.total + 12_400,
    totals.monthTotal,
    totals.month,
    totals.streak,
    localDate(origin),
    new Date(origin).toISOString(),
  );
};

const insertTerms = (db, origin) => {
  const insert = db.prepare(
    `INSERT INTO terms (id, created_at, created_by_user_id, source_value, destination_value, is_deleted, is_replacement)
     VALUES (?, ?, 'local', ?, ?, 0, 1)`,
  );
  terms.forEach(([source, destination], index) =>
    insert.run(`guide-term-${index}`, origin - index * 1000, source, destination),
  );
};

const insertConversation = (db, origin) => {
  const insertMessage = db.prepare(
    "INSERT INTO chat_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("guide-conversation", conversation.title, at(origin, 1, 10), at(origin, 0, 10));
  conversation.messages.forEach(([role, content], index) =>
    insertMessage.run(
      `guide-message-${index}`,
      "guide-conversation",
      role,
      content,
      at(origin, 1, 10) + index * 60_000,
    ),
  );
};

const insertTargets = (db) => {
  const insert = db.prepare(
    "INSERT INTO app_targets (id, name, created_at) VALUES (?, ?, ?)",
  );
  for (const [index, name] of ["Slack", "Notes", "Mail"].entries()) {
    insert.run(`guide-target-${index}`, name, new Date().toISOString());
  }
};

/**
 * Fill `dbPath` with the sample history the figures show. Returns
 * `{ seeded: false, transcriptions }` when the database already holds real
 * history, so the caller decides whether that is a skip or a failure.
 */
export const seedGuideData = (dbPath = defaultDb) => {
  const db = new DatabaseSync(dbPath);
  const existing = db.prepare("SELECT COUNT(*) AS n FROM transcriptions").get();
  if (existing.n > 0) {
    db.close();
    return { seeded: false, dbPath, transcriptions: existing.n };
  }
  const origin = Date.now();
  db.exec("BEGIN");
  insertSampleTranscriptions(db, origin);
  const daily = insertDailyActivity(db, origin);
  insertProfile(db, profileTotals(daily, origin), origin);
  insertTerms(db, origin);
  insertConversation(db, origin);
  insertTargets(db);
  db.exec("COMMIT");
  db.close();
  return {
    seeded: true,
    dbPath,
    transcriptions: transcriptions.length,
    terms: terms.length,
    messages: conversation.messages.length,
    targets: 3,
  };
};

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const argIndex = process.argv.indexOf("--db");
  const dbPath = argIndex >= 0 ? process.argv[argIndex + 1] : defaultDb;
  const result = seedGuideData(dbPath);
  if (!result.seeded) {
    console.error(
      `${dbPath} already holds ${result.transcriptions} transcriptions. Refusing to add sample data to a database that has history.`,
    );
    process.exit(1);
  }
  console.log(
    `seeded ${result.transcriptions} transcriptions, ${result.terms} terms, ${result.messages} chat messages and ${result.targets} app targets into ${dbPath}`,
  );
}
