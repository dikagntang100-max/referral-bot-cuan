
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TOKEN = process.env.BOT_TOKEN;
const ADMIN = "8994767068";
const GROUP_ID = process.env.REQUIRED_GROUP_ID;
const GROUP_LINK = "https://t.me/+CFQK3hH1cR1lNGY1";
const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, data) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return r.json();
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      balance BIGINT DEFAULT 0,
      referred_by TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS redemptions (
      code TEXT PRIMARY KEY,
      amount BIGINT NOT NULL,
      max_uses INTEGER NOT NULL,
      uses INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS redeem_uses (
      code TEXT,
      user_id TEXT,
      PRIMARY KEY(code,user_id)
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      amount BIGINT,
      destination TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pending_actions (
      user_id TEXT PRIMARY KEY,
      action TEXT,
      data TEXT
    );
  `);
}

async function send(id, text, keyboard) {
  return tg("sendMessage", {
    chat_id: id,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard
  });
}

const menu = {
  keyboard: [
    ["👥 Undang Teman", "💰 Tarik Dana"],
    ["🎁 Redeem Kode", "🆘 Bantuan"]
  ],
  resize_keyboard: true
};

async function member(id) {
  if (!GROUP_ID) return false;

  const r = await tg("getChatMember", {
    chat_id: GROUP_ID,
    user_id: id
  });

  return r.ok &&
    ["creator", "administrator", "member"].includes(
      r.result.status
    );
}

async function dashboard(id) {
  const r = await pool.query(
    "SELECT * FROM users WHERE id=$1", [String(id)]
  );

  if (!r.rows.length) return;

  const u = r.rows[0];

  const refs = await pool.query(
    "SELECT COUNT(*) FROM users WHERE referred_by=$1",
    [String(id)]
  );

  const count = Number(refs.rows[0].count);

  await send(id,
    `🌟 <b>MAWZZ REFERRAL</b>\n\n` +
    `🆔 ID: <code>${id}</code>\n` +
    `💰 Saldo: Rp${Number(u.balance).toLocaleString("id-ID")}\n` +
    `👥 Referral: ${count} orang\n` +
    `🎯 Syarat WD: ${count}/15 orang\n\n` +
    `Bonus referral: Rp2.000/orang`,
    menu
  );
}

async function register(id, username, ref) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO users(id,username,referred_by)
       VALUES($1,$2,$3)
       ON CONFLICT(id) DO NOTHING
       RETURNING id`,
      [String(id), username || "", ref || null]
    );

    if (result.rows.length && ref && ref !== String(id)) {
      const inviter = await client.query(
        "SELECT id FROM users WHERE id=$1",
        [String(ref)]
      );

      if (inviter.rows.length) {
        await client.query(
          "UPDATE users SET balance=balance+2000 WHERE id=$1",
          [String(ref)]
        );
      } else {
        await client.query(
          "UPDATE users SET referred_by=NULL WHERE id=$1",
          [String(id)]
        );
      }
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function referral(id) {
  const me = await tg("getMe");
  const username = me.result.username;

  const link = `https://t.me/${username}?start=${id}`;

  await send(id,
    `👥 <b>LINK REFERRAL KAMU</b>\n\n` +
    `Bagikan link berikut kepada teman:\n\n` +
    `<code>${link}</code>\n\n` +
    `💵 Bonus: Rp2.000 per referral valid.\n` +
    `Minimal WD: 15 referral valid.`,
    menu
  );
}

async function startWithdrawal(id) {
  const refs = await pool.query(
    "SELECT COUNT(*) FROM users WHERE referred_by=$1",
    [String(id)]
  );

  const count = Number(refs.rows[0].count);

  if (count < 15) {
    return send(id,
      `❌ Referral belum cukup.\n\n` +
      `Referral kamu: ${count}/15 orang.\n` +
      `Kamu masih membutuhkan ${15-count} referral valid.`,
      menu
    );
  }

  await pool.query(
    `INSERT INTO pending_actions(user_id,action,data)
     VALUES($1,'wd_amount','')
     ON CONFLICT(user_id)
     DO UPDATE SET action='wd_amount',data=''`,
    [String(id)]
  );

  await send(id,
    "💰 <b>PENARIKAN DANA</b>\n\nMasukkan nominal WD dalam rupiah:"
  );
}

async function createWithdrawal(id, amount, destination) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const u = await client.query(
      "SELECT balance FROM users WHERE id=$1 FOR UPDATE",
      [String(id)]
    );

    if (!u.rows.length || Number(u.rows[0].balance) < amount) {
      await client.query("ROLLBACK");
      return send(id, "❌ Saldo tidak mencukupi.", menu);
    }

    const w = await client.query(
      `INSERT INTO withdrawals(user_id,amount,destination)
       VALUES($1,$2,$3) RETURNING id`,
      [String(id), amount, destination]
    );

    await client.query("COMMIT");

    await send(ADMIN,
      `🔔 <b>PERMINTAAN WD BARU</b>\n\n` +
      `ID WD: #${w.rows[0].id}\n` +
      `ID Telegram: <code>${id}</code>\n` +
      `Nominal: Rp${amount.toLocaleString("id-ID")}\n` +
      `Nomor tujuan: <code>${escapeHtml(destination)}</code>\n` +
      `Status: Menunggu persetujuan`,
      {
        inline_keyboard: [[
          { text: "✅ Setujui", callback_data: `approve_${w.rows[0].id}` },
          { text: "❌ Tolak", callback_data: `reject_${w.rows[0].id}` }
        ]]
      }
    );

    await send(id,
      "✅ Permintaan WD berhasil dikirim.\nMenunggu pemeriksaan admin."
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[c]);
}

async function handleText(id, text, username) {
  const p = await pool.query(
    "SELECT * FROM pending_actions WHERE user_id=$1",
    [String(id)]
  );

  if (p.rows.length) {
    const action = p.rows[0].action;

    if (action === "wd_amount") {
      const amount = Number(text.replace(/\D/g, ""));

      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return send(id, "Nominal tidak valid. Masukkan angka yang benar.");
      }

      await pool.query(
        "UPDATE pending_actions SET action='wd_destination',data=$1 WHERE user_id=$2",
        [String(amount), String(id)]
      );

      return send(id,
        "Masukkan nomor tujuan penarikan (misalnya nomor DANA atau rekening):"
      );
    }

    if (action === "wd_destination") {
      const amount = Number(p.rows[0].data);

      if (text.length < 5 || text.length > 80) {
        return send(id, "Nomor tujuan tidak valid. Coba masukkan kembali.");
      }

      await pool.query(
        "DELETE FROM pending_actions WHERE user_id=$1",
        [String(id)]
      );

      return createWithdrawal(id, amount, text);
    }

    if (action === "redeem") {
      await pool.query(
        "DELETE FROM pending_actions WHERE user_id=$1",
        [String(id)]
      );

      return redeem(id, text.trim().toUpperCase());
    }
  }

  if (String(id) === ADMIN && text.startsWith("/buatkode")) {
    const parts = text.trim().split(/\s+/);
    const code = parts[1]?.toUpperCase();
    const amount = Number(parts[2]);
    const limit = Number(parts[3]);

    if (!code || !Number.isSafeInteger(amount) ||
        amount <= 0 || !Number.isInteger(limit) || limit < 1) {
      return send(id,
        "Format:\n<code>/buatkode KODE NOMINAL JUMLAH</code>\n\nContoh:\n<code>/buatkode MAWZZ10 10000 100</code>"
      );
    }

    await pool.query(
      `INSERT INTO redemptions(code,amount,max_uses)
       VALUES($1,$2,$3)`,
      [code, amount, limit]
    );

    return send(id,
      `✅ Kode ${code} berhasil dibuat.\nHadiah: Rp${amount.toLocaleString("id-ID")}\nBatas penggunaan: ${limit}`
    );
  }

  if (String(id) === ADMIN && text.startsWith("/selesai")) {
    const wid = Number(text.split(/\s+/)[1]);

    if (!Number.isInteger(wid)) {
      return send(id, "Format: /selesai ID_WD");
    }

    const r = await pool.query(
      `UPDATE withdrawals SET status='completed'
       WHERE id=$1 AND status='approved'
       RETURNING user_id`,
      [wid]
    );

    if (!r.rows.length) return send(id, "WD tidak ditemukan atau belum disetujui.");

    await send(r.rows[0].user_id,
      `🎉 Pembayaran WD #${wid} telah ditandai selesai oleh admin.`
    );

    return send(id, "✅ WD ditandai selesai.");
  }

  if (text === "👥 Undang Teman") return referral(id);
  if (text === "💰 Tarik Dana") return startWithdrawal(id);

  if (text === "🎁 Redeem Kode") {
    await pool.query(
      `INSERT INTO pending_actions(user_id,action,data)
       VALUES($1,'redeem','')
       ON CONFLICT(user_id)
       DO UPDATE SET action='redeem',data=''`,
      [String(id)]
    );

    return send(id, "Masukkan kode redeem kamu:");
  }

  if (text === "🆘 Bantuan") {
    return send(id,
      "🆘 <b>BANTUAN MAWZZ REFERRAL</b>\n\n" +
      "Hubungi admin jika mengalami kendala.\n" +
      "Admin ID: 8994767068"
    );
  }

  if (text === "/admin" && String(id) === ADMIN) {
    return send(id,
      "👑 <b>MENU ADMIN</b>\n\n" +
      "/buatkode KODE NOMINAL JUMLAH\n" +
      "/selesai ID_WD\n\n" +
      "Setujui atau tolak WD melalui tombol notifikasi."
    );
  }

  return dashboard(id);
}

async function redeem(id, code) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const r = await client.query(
      "SELECT * FROM redemptions WHERE code=$1 FOR UPDATE",
      [code]
    );

    if (!r.rows.length || Number(r.rows[0].uses) >= Number(r.rows[0].max_uses)) {
      await client.query("ROLLBACK");
      return send(id, "❌ Kode tidak valid atau sudah habis.");
    }

    const used = await client.query(
      `INSERT INTO redeem_uses(code,user_id)
       VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING user_id`,
      [code, String(id)]
    );

    if (!used.rows.length) {
      await client.query("ROLLBACK");
      return send(id, "❌ Kamu sudah menggunakan kode ini.");
    }

    await client.query(
      "UPDATE redemptions SET uses=uses+1 WHERE code=$1",
      [code]
    );

    await client.query(
      "UPDATE users SET balance=balance+$1 WHERE id=$2",
      [r.rows[0].amount, String(id)]
    );

    await client.query("COMMIT");

    return send(id,
      `🎉 Redeem berhasil!\nSaldo bertambah Rp${Number(r.rows[0].amount).toLocaleString("id-ID")}.`,
      menu
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function callback(q) {
  const id = String(q.from.id);
  const data = q.data;

  if (data.startsWith("check_")) {
    const ref = data.slice(6);
    if (!(await member(id))) {
      return tg("answerCallbackQuery", {
        callback_query_id: q.id,
        text: "Kamu belum bergabung ke grup!",
        show_alert: true
      });
    }

    await register(id, q.from.username, ref);
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Berhasil!" });
    return dashboard(id);
  }

  if (id !== ADMIN) {
    return tg("answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Akses admin saja.",
      show_alert: true
    });
  }

  const [action, wid] = data.split("_");
  if (!["approve", "reject"].includes(action)) return;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const w = await client.query(
      "SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",
      [wid]
    );

    if (!w.rows.length || w.rows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return tg("answerCallbackQuery", {
        callback_query_id: q.id,
        text: "WD sudah diproses.",
        show_alert: true
      });
    }

    if (action === "approve") {
      const debit = await client.query(
        `UPDATE users SET balance=balance-$1
         WHERE id=$2 AND balance >= $1 RETURNING id`,
        [w.rows[0].amount, w.rows[0].user_id]
      );

      if (!debit.rows.length) {
        await client.query("ROLLBACK");
        return send(ADMIN, "❌ Saldo pengguna tidak mencukupi.");
      }

      await client.query(
        "UPDATE withdrawals SET status='approved' WHERE id=$1",
        [wid]
      );
    } else {
      await client.query(
        "UPDATE withdrawals SET status='rejected' WHERE id=$1",
        [wid]
      );
    }

    await client.query("COMMIT");

    const user = w.rows[0].user_id;

    await send(user, action === "approve"
      ? `✅ WD #${wid} disetujui admin.\nPembayaran sedang diproses dan ditargetkan maksimal 1×24 jam.`
      : `❌ WD #${wid} ditolak admin. Saldo tidak dipotong.`
    );

    await tg("answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Berhasil diproses."
    });

  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("MAWZZ Referral Bot aktif");
  }

  try {
    if (!TOKEN || !process.env.DATABASE_URL) {
      return res.status(500).send("Environment belum lengkap");
    }

    await initDB();

    const update = req.body;

    if (update.callback_query) {
      await callback(update.callback_query);
      return res.status(200).send("OK");
    }

    const m = update.message;
    if (!m || !m.from || !m.chat) {
      return res.status(200).send("OK");
    }

    const id = String(m.from.id);
    const text = m.text || "";

    if (text.startsWith("/start")) {
      if (!(await member(id))) {
        const ref = text.split(/\s+/)[1] || "";
        return await send(id,
          "👋 <b>SELAMAT DATANG DI MAWZZ REFERRAL</b>\n\n" +
          "Silakan gabung grup terlebih dahulu untuk menggunakan bot.",
          {
            inline_keyboard: [
              [{ text: "📢 Gabung Grup", url: GROUP_LINK }],
              [{ text: "✅ Cek Keanggotaan", callback_data: `check_${ref}` }]
            ]
          }
        ).then(() => res.status(200).send("OK"));
      }

      const ref = text.split(/\s+/)[1] || "";
      await register(id, m.from.username, ref);
      await dashboard(id);
    } else {
      const exists = await pool.query(
        "SELECT id FROM users WHERE id=$1", [id]
      );

      if (!exists.rows.length) {
        await send(id, "Kirim /start untuk memulai bot.");
      } else {
        await handleText(id, text, m.from.username);
      }
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Internal error");
  }
}
