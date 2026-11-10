
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
const ADMIN_LINK = "https://t.me/Budi2012";
const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, data) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return r.json();
}

async function send(id, text, keyboard) {
  return tg("sendMessage", {
    chat_id: id,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard
  });
}

async function db(sql, values = []) {
  return pool.query(sql, values);
}

async function initDB() {
  await db(`
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

const userMenu = {
  keyboard: [
    ["👥 Undang Teman", "💰 Tarik Dana"],
    ["🎁 Redeem Kode", "🆘 Bantuan"]
  ],
  resize_keyboard: true
};

const adminMenu = {
  keyboard: [
    ["📊 Statistik", "👥 Daftar Pengguna"],
    ["💰 Kelola Saldo", "🎁 Buat Redeem"],
    ["📋 Daftar Redeem", "💸 Daftar WD"],
    ["⬅️ Menu Pengguna"]
  ],
  resize_keyboard: true
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

async function isMember(id) {
  if (!GROUP_ID) return false;

  const r = await tg("getChatMember", {
    chat_id: GROUP_ID,
    user_id: id
  });

  return r.ok &&
    ["creator", "administrator", "member"].includes(r.result.status);
}

async function setAction(id, action, data = "") {
  await db(`
    INSERT INTO pending_actions(user_id,action,data)
    VALUES($1,$2,$3)
    ON CONFLICT(user_id)
    DO UPDATE SET action=$2,data=$3
  `, [String(id), action, String(data)]);
}

async function clearAction(id) {
  await db("DELETE FROM pending_actions WHERE user_id=$1", [String(id)]);
}

async function getAction(id) {
  const r = await db(
    "SELECT * FROM pending_actions WHERE user_id=$1",
    [String(id)]
  );
  return r.rows[0];
}

async function register(id, username, ref) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(`
      INSERT INTO users(id,username,referred_by)
      VALUES($1,$2,$3)
      ON CONFLICT(id) DO NOTHING
      RETURNING id
    `, [String(id), username || "", ref || null]);

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

async function dashboard(id) {
  const r = await db(
    "SELECT * FROM users WHERE id=$1",
    [String(id)]
  );

  if (!r.rows.length) return;

  const u = r.rows[0];

  const refs = await db(
    "SELECT COUNT(*) FROM users WHERE referred_by=$1",
    [String(id)]
  );

  const count = Number(refs.rows[0].count);

  await send(id,
    `🌟 <b>MAWZZ REFERRAL</b>\n\n` +
    `🆔 ID: <code>${id}</code>\n` +
    `💰 Saldo: Rp${Number(u.balance).toLocaleString("id-ID")}\n` +
    `👥 Referral: ${count}/15 orang\n\n` +
    `🎁 Bonus referral: Rp2.000\n` +
    `💸 Minimal referral WD: 15 orang`,
    userMenu
  );
}

async function referral(id) {
  const me = await tg("getMe");
  const link = `https://t.me/${me.result.username}?start=${id}`;

  await send(id,
    `👥 <b>LINK REFERRAL KAMU</b>\n\n` +
    `Bagikan link berikut kepada teman:\n\n` +
    `<code>${link}</code>\n\n` +
    `💵 Bonus: Rp2.000 per referral valid.\n` +
    `🎯 Minimal WD: 15 referral valid.`,
    userMenu
  );
}

async function startWD(id) {
  const r = await db(
    "SELECT COUNT(*) FROM users WHERE referred_by=$1",
    [String(id)]
  );

  const count = Number(r.rows[0].count);

  if (count < 15) {
    return send(id,
      `❌ Referral belum cukup.\n\n` +
      `Referral kamu: ${count}/15.\n` +
      `Kurang ${15-count} referral lagi.`,
      userMenu
    );
  }

  await setAction(id, "wd_amount");

  await send(id,
    "💰 <b>PENARIKAN DANA</b>\n\nMasukkan nominal penarikan:"
  );
}

async function createWD(id, amount, destination) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const u = await client.query(
      "SELECT balance FROM users WHERE id=$1 FOR UPDATE",
      [String(id)]
    );

    if (!u.rows.length || Number(u.rows[0].balance) < amount) {
      await client.query("ROLLBACK");
      return send(id, "❌ Saldo tidak mencukupi.", userMenu);
    }

    const w = await client.query(`
      INSERT INTO withdrawals(user_id,amount,destination)
      VALUES($1,$2,$3)
      RETURNING id
    `, [String(id), amount, destination]);

    await client.query("COMMIT");

    await send(ADMIN,
      `🔔 <b>PERMINTAAN WD BARU</b>\n\n` +
      `ID WD: #${w.rows[0].id}\n` +
      `ID Telegram: <code>${id}</code>\n` +
      `Nominal: Rp${amount.toLocaleString("id-ID")}\n` +
      `Nomor tujuan: <code>${esc(destination)}</code>\n` +
      `Status: Menunggu persetujuan`,
      {
        inline_keyboard: [[
          { text: "✅ Setujui", callback_data: `approve_${w.rows[0].id}` },
          { text: "❌ Tolak", callback_data: `reject_${w.rows[0].id}` }
        ]]
      }
    );

    await send(id,
      "✅ Permintaan WD sudah dikirim dan menunggu pemeriksaan admin.",
      userMenu
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function redeem(id, code) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const r = await client.query(
      "SELECT * FROM redemptions WHERE code=$1 FOR UPDATE",
      [code]
    );

    if (!r.rows.length ||
        Number(r.rows[0].uses) >= Number(r.rows[0].max_uses)) {
      await client.query("ROLLBACK");
      return send(id, "❌ Kode tidak valid atau sudah habis.", userMenu);
    }

    const used = await client.query(`
      INSERT INTO redeem_uses(code,user_id)
      VALUES($1,$2)
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `, [code, String(id)]);

    if (!used.rows.length) {
      await client.query("ROLLBACK");
      return send(id, "❌ Kode sudah pernah digunakan.", userMenu);
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
      userMenu
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function adminStats(id) {
  const u = await db("SELECT COUNT(*) FROM users");
  const b = await db("SELECT COALESCE(SUM(balance),0) AS total FROM users");
  const w = await db(
    "SELECT COUNT(*) FROM withdrawals WHERE status='pending'"
  );

  await send(id,
    `📊 <b>STATISTIK BOT</b>\n\n` +
    `👥 Total pengguna: ${u.rows[0].count}\n` +
    `💰 Total saldo: Rp${Number(b.rows[0].total).toLocaleString("id-ID")}\n` +
    `💸 WD menunggu: ${w.rows[0].count}`,
    adminMenu
  );
}

async function adminUsers(id) {
  const r = await db(
    "SELECT id,username,balance FROM users ORDER BY created_at DESC LIMIT 20"
  );

  if (!r.rows.length) return send(id, "Belum ada pengguna.", adminMenu);

  let out = "👥 <b>20 PENGGUNA TERBARU</b>\n\n";

  for (const u of r.rows) {
    out += `ID: <code>${esc(u.id)}</code>\n`;
    out += `Username: @${esc(u.username || "-")}\n`;
    out += `Saldo: Rp${Number(u.balance).toLocaleString("id-ID")}\n\n`;
  }

  await send(id, out, adminMenu);
}

async function adminRedeems(id) {
  const r = await db(
    "SELECT * FROM redemptions ORDER BY code LIMIT 30"
  );

  if (!r.rows.length) return send(id, "Belum ada kode redeem.", adminMenu);

  let out = "🎁 <b>DAFTAR REDEEM</b>\n\n";

  for (const x of r.rows) {
    out += `Kode: <code>${esc(x.code)}</code>\n`;
    out += `Hadiah: Rp${Number(x.amount).toLocaleString("id-ID")}\n`;
    out += `Penggunaan: ${x.uses}/${x.max_uses}\n\n`;
  }

  await send(id, out, adminMenu);
}

async function adminWD(id) {
  const r = await db(`
    SELECT * FROM withdrawals
    ORDER BY created_at DESC LIMIT 20
  `);

  if (!r.rows.length) return send(id, "Belum ada permintaan WD.", adminMenu);

  let out = "💸 <b>RIWAYAT WD TERBARU</b>\n\n";

  for (const w of r.rows) {
    out += `ID: #${w.id}\n`;
    out += `Pengguna: <code>${esc(w.user_id)}</code>\n`;
    out += `Nominal: Rp${Number(w.amount).toLocaleString("id-ID")}\n`;
    out += `Status: ${esc(w.status)}\n\n`;
  }

  await send(id, out, adminMenu);
}

async function callback(q) {
  const id = String(q.from.id);
  const data = q.data || "";

  if (data.startsWith("check_")) {
    const ref = data.slice(6);

    if (!(await isMember(id))) {
      return tg("answerCallbackQuery", {
        callback_query_id: q.id,
        text: "Kamu belum bergabung ke grup!",
        show_alert: true
      });
    }

    await register(id, q.from.username, ref);
    await tg("answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Keanggotaan berhasil diperiksa."
    });

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
      const debit = await client.query(`
        UPDATE users SET balance=balance-$1
        WHERE id=$2 AND balance >= $1
        RETURNING id
      `, [w.rows[0].amount, w.rows[0].user_id]);

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

    await send(w.rows[0].user_id,
      action === "approve"
        ? `✅ WD #${wid} disetujui admin.\nPembayaran sedang diproses. Estimasi maksimal 1×24 jam.`
        : `❌ WD #${wid} ditolak. Saldo tidak dipotong.`
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

async function handleAdmin(id, text) {
  if (text === "/admin") {
    return send(id, "👑 <b>PANEL ADMIN MAWZZ</b>", adminMenu);
  }

  if (text === "📊 Statistik") return adminStats(id);
  if (text === "👥 Daftar Pengguna") return adminUsers(id);
  if (text === "📋 Daftar Redeem") return adminRedeems(id);
  if (text === "💸 Daftar WD") return adminWD(id);

  if (text === "⬅️ Menu Pengguna") {
    return dashboard(id);
  }

  if (text === "🎁 Buat Redeem") {
    await setAction(id, "create_code");
    return send(id, "Masukkan nama kode redeem:");
  }

  if (text === "💰 Kelola Saldo") {
    await setAction(id, "balance_user");
    return send(id,
      "Masukkan ID Telegram pengguna yang saldonya ingin diubah:"
    );
  }

  return handleAdminInput(id, text);
}

async function handleAdminInput(id, text) {
  const p = await getAction(id);
  if (!p) return send(id, "Gunakan tombol menu admin.", adminMenu);

  if (p.action === "create_code") {
    const code = text.trim().toUpperCase();

    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) {
      return send(id, "Kode tidak valid. Gunakan 3-30 karakter.");
    }

    await setAction(id, "create_amount", code);
    return send(id, "Masukkan nominal hadiah redeem dalam rupiah:");
  }

  if (p.action === "create_amount") {
    const amount = Number(text.replace(/\D/g, ""));

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return send(id, "Nominal tidak valid.");
    }

    await setAction(id, "create_limit", `${p.data}|${amount}`);
    return send(id, "Masukkan batas jumlah penggunaan kode:");
  }

  if (p.action === "create_limit") {
    const limit = Number(text);
    const [code, amount] = p.data.split("|");

    if (!Number.isInteger(limit) || limit < 1) {
      return send(id, "Jumlah penggunaan tidak valid.");
    }

    await db(`
      INSERT INTO redemptions(code,amount,max_uses)
      VALUES($1,$2,$3)
    `, [code, Number(amount), limit]);

    await clearAction(id);

    return send(id,
      `✅ <b>REDEEM BERHASIL DIBUAT</b>\n\nKode: <code>${code}</code>\nHadiah: Rp${Number(amount).toLocaleString("id-ID")}\nBatas: ${limit} pengguna`,
      adminMenu
    );
  }

  if (p.action === "balance_user") {
    const target = text.trim();

    const u = await db(
      "SELECT id FROM users WHERE id=$1",
      [target]
    );

    if (!u.rows.length) return send(id, "Pengguna tidak ditemukan.");

    await setAction(id, "balance_amount", target);

    return send(id,
      "Masukkan perubahan saldo.\nContoh: +10000 atau -5000"
    );
  }

  if (p.action === "balance_amount") {
    const match = text.trim().match(/^([+-])(\d+)$/);

    if (!match || Number(match[2]) <= 0) {
      return send(id, "Format salah. Contoh: +10000 atau -5000");
    }

    const delta = Number(match[2]) * (match[1] === "+" ? 1 : -1);

    const r = await db(`
      UPDATE users SET balance=balance+$1
      WHERE id=$2 AND balance+$1 >= 0
      RETURNING balance
    `, [delta, p.data]);

    if (!r.rows.length) {
      return send(id, "❌ Saldo tidak mencukupi untuk pengurangan.");
    }

    await clearAction(id);

    await send(p.data,
      `🔔 Saldo kamu telah disesuaikan admin.\nSaldo sekarang: Rp${Number(r.rows[0].balance).toLocaleString("id-ID")}`
    );

    return send(id, "✅ Perubahan saldo berhasil.", adminMenu);
  }

  return send(id, "Perintah tidak dikenali.", adminMenu);
}

async function handleUser(id, text, username) {
  const p = await getAction(id);

  if (p) {
    if (p.action === "wd_amount") {
      const amount = Number(text.replace(/\D/g, ""));

      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return send(id, "Nominal tidak valid.");
      }

      await setAction(id, "wd_destination", String(amount));
      return send(id, "Masukkan nomor tujuan penarikan:");
    }

    if (p.action === "wd_destination") {
      const amount = Number(p.data);

      if (text.length < 5 || text.length > 80) {
        return send(id, "Nomor tujuan tidak valid.");
      }

      await clearAction(id);
      return createWD(id, amount, text);
    }

    if (p.action === "redeem") {
      await clearAction(id);
      return redeem(id, text.trim().toUpperCase());
    }
  }

  if (text === "👥 Undang Teman") return referral(id);
  if (text === "💰 Tarik Dana") return startWD(id);

  if (text === "🎁 Redeem Kode") {
    await setAction(id, "redeem");
    return send(id, "🎁 Masukkan kode redeem kamu:");
  }

  if (text === "🆘 Bantuan") {
    return send(id,
      `🆘 <b>PUSAT BANTUAN MAWZZ</b>\n\n` +
      `Jika mengalami masalah dengan referral, saldo, redeem, atau WD, silakan hubungi admin kami.\n\n` +
      `Admin: @Budi2012`,
      {
        inline_keyboard: [[
          {
            text: "📩 HUBUNGI ADMIN",
            url: ADMIN_LINK
          }
        ]]
      }
    );
  }

  return dashboard(id);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("MAWZZ Referral Bot aktif");
  }

  if (!TOKEN || !process.env.DATABASE_URL || !GROUP_ID) {
    return res.status(500).send("Environment belum lengkap.");
  }

  try {
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
      if (!(await isMember(id))) {
        const ref = text.split(/\s+/)[1] || "";

        await send(id,
          `👋 <b>SELAMAT DATANG DI MAWZZ REFERRAL</b>\n\n` +
          `Kamu harus bergabung ke grup terlebih dahulu untuk menggunakan bot.`,
          {
            inline_keyboard: [
              [{ text: "📢 GABUNG GRUP", url: GROUP_LINK }],
              [{ text: "✅ CEK KEANGGOTAAN", callback_data: `check_${ref}` }]
            ]
          }
        );

        return res.status(200).send("OK");
      }

      const ref = text.split(/\s+/)[1] || "";

      await register(id, m.from.username, ref);

      if (id === ADMIN) {
        await send(id, "👑 Selamat datang Admin MAWZZ!", adminMenu);
      } else {
        await dashboard(id);
      }

      return res.status(200).send("OK");
    }

    const exists = await db(
      "SELECT id FROM users WHERE id=$1",
      [id]
    );

    if (!exists.rows.length) {
      await send(id, "Kirim /start untuk memulai bot.");
      return res.status(200).send("OK");
    }

    if (id === ADMIN) {
      await handleAdmin(id, text);
    } else {
      await handleUser(id, text, m.from.username);
    }

    return res.status(200).send("OK");

  } catch (e) {
    console.error("MAWZZ BOT ERROR:", e);
    return res.status(500).send("Internal error");
  }
}
