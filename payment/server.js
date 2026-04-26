require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const path    = require('path');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

const NP_CLIENT_ID  = process.env.NICEPAY_CLIENT_ID;
const NP_SECRET_KEY = process.env.NICEPAY_SECRET_KEY;
const NP_API_URL    = process.env.NICEPAY_API_URL || 'https://sandbox-api.nicepay.co.kr';

const SP_API_KEY              = process.env.SOLAPI_API_KEY;
const SP_API_SECRET           = process.env.SOLAPI_API_SECRET;
const SP_CHANNEL_ID           = process.env.SOLAPI_CHANNEL_ID;
const SP_TEMPLATE_CODE        = process.env.SOLAPI_TEMPLATE_CODE;
const SP_CANCEL_TEMPLATE_CODE = process.env.SOLAPI_CANCEL_TEMPLATE_CODE;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pokerfish2024';

const pendingOrders = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..')));

// ── 관리자 인증 미들웨어 ──────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: '인증 실패' });
}

// ── 1. 결제 직전: 주문 정보 저장 ─────────────────────────────────────────────
app.post('/payment/prepare', (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId 없음' });
  pendingOrders.set(orderId, { ...req.body, savedAt: Date.now() });
  res.json({ ok: true });
});

// ── 2. 나이스페이먼츠 결제 승인 ───────────────────────────────────────────────
app.post('/payment/approve', async (req, res) => {
  const { tid, status, orderId, amount } = req.body;

  if (status === 'fail') {
    const q = new URLSearchParams({ orderId: orderId || '', message: '결제가 취소되었습니다.' });
    return res.redirect(`/payment/fail.html?${q}`);
  }

  try {
    const basic = Buffer.from(`${NP_CLIENT_ID}:${NP_SECRET_KEY}`).toString('base64');
    const { data } = await axios.post(
      `${NP_API_URL}/v1/payments/${tid}`,
      { amount: Number(amount) },
      { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    if (data.resultCode === '0000') {
      const order = pendingOrders.get(orderId);
      if (order) {
        pendingOrders.delete(orderId);

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const createdAt = `${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

        try {
          db.saveOrder.run({
            orderId      : data.orderId  || order.orderId,
            name         : order.name    || '',
            phone        : order.phone   || '',
            address      : order.address || '',
            items        : JSON.stringify(order.items || []),
            goodsName    : data.goodsName || order.goodsName || '',
            totalAmount  : Number(data.amount || order.total),
            paymentMethod: order.payment || '',
            paymentTid   : data.tid || tid,
            message      : order.message || '',
            createdAt,
          });
        } catch (dbErr) {
          console.error('[DB] 주문 저장 실패:', dbErr.message);
        }

        sendAlimtalk(data, order).catch(err =>
          console.error('[Solapi] 알림톡 발송 실패:', err.response?.data || err.message)
        );
      }

      const q = new URLSearchParams({
        orderId  : data.orderId   || orderId,
        amount   : data.amount    || amount,
        goodsName: data.goodsName || '',
        method   : data.channel   || '',
        tid      : data.tid       || tid,
      });
      return res.redirect(`/payment/success.html?${q}`);
    }

    const q = new URLSearchParams({ orderId: orderId || '', message: data.resultMsg || '결제 승인 실패' });
    res.redirect(`/payment/fail.html?${q}`);

  } catch (err) {
    console.error('[NicePay] 승인 오류:', err.response?.data || err.message);
    const q = new URLSearchParams({ orderId: orderId || '', message: '결제 처리 중 오류가 발생했습니다.' });
    res.redirect(`/payment/fail.html?${q}`);
  }
});

// ── 3. 비회원 주문조회 ────────────────────────────────────────────────────────
app.get('/api/order', (req, res) => {
  const { orderId, phone4 } = req.query;
  if (!orderId || !phone4) return res.status(400).json({ error: '주문번호와 전화번호 뒤 4자리를 입력해주세요.' });

  const order = db.findOrder.get(orderId.trim(), phone4.trim());
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다. 입력 정보를 확인해주세요.' });

  try { order.items = JSON.parse(order.items); } catch(e) { order.items = []; }
  res.json(order);
});

// ── 4. 비회원 주문취소 ────────────────────────────────────────────────────────
app.post('/api/order/cancel', async (req, res) => {
  const { orderId, phone4, reason } = req.body;
  if (!orderId || !phone4) return res.status(400).json({ error: '주문번호와 전화번호 뒤 4자리를 입력해주세요.' });

  const order = db.findOrder.get(orderId.trim(), phone4.trim());
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
  if (order.status === '취소완료') return res.status(400).json({ error: '이미 취소된 주문입니다.' });
  if (['배송중', '배송완료'].includes(order.status))
    return res.status(400).json({ error: `${order.status} 상태에서는 취소가 불가합니다.` });

  try {
    const basic = Buffer.from(`${NP_CLIENT_ID}:${NP_SECRET_KEY}`).toString('base64');
    await axios.post(
      `${NP_API_URL}/v1/payments/${order.payment_tid}/cancel`,
      { reason: reason || '고객 요청', orderId },
      { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
  } catch (err) {
    console.error('[NicePay] 취소 오류:', err.response?.data || err.message);
    return res.status(502).json({ error: '결제 취소 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const cancelledAt = `${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  db.cancelOrder.run({ orderId, cancelReason: reason || '고객 요청', cancelledAt });

  if (SP_CANCEL_TEMPLATE_CODE) {
    sendCancelAlimtalk(order, cancelledAt).catch(err =>
      console.error('[Solapi] 취소 알림톡 실패:', err.response?.data || err.message)
    );
  }

  res.json({ ok: true, message: '주문이 취소되었습니다.' });
});

// ── 5. 관리자: 전체 주문 목록 ─────────────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.listOrders.all();
  orders.forEach(o => {
    try { o.items = JSON.parse(o.items); } catch(e) { o.items = []; }
  });
  res.json(orders);
});

// ── 6. 관리자: 주문 상태 / 운송장 변경 ──────────────────────────────────────
app.patch('/api/admin/orders/:orderId', requireAdmin, (req, res) => {
  const { orderId } = req.params;
  const { status, trackingNumber } = req.body;
  const order = db.getOrder.get(orderId);
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

  db.updateStatus.run({
    orderId,
    status        : status         ?? order.status,
    trackingNumber: trackingNumber ?? order.tracking_number,
  });
  res.json({ ok: true });
});

// ── 솔라피 공통 ───────────────────────────────────────────────────────────────
function getSolapiAuth() {
  const date      = new Date().toISOString();
  const salt      = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', SP_API_SECRET).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${SP_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function solapiSend(to, templateId, variables) {
  await axios.post(
    'https://api.solapi.com/messages/v4/send',
    {
      message: {
        to,
        kakaoOptions: { pfId: SP_CHANNEL_ID, templateId, variables },
      },
    },
    { headers: { Authorization: getSolapiAuth(), 'Content-Type': 'application/json' }, timeout: 10000 }
  );
}

async function sendAlimtalk(paymentData, order) {
  const methodLabel = { card: '신용카드', kakaopay: '카카오페이', naverpay: '네이버페이', bank: '계좌이체' };
  const itemLines = (order.items || []).map(item => {
    const opts = [item.design, item.color, item.size].filter(Boolean).join(' · ');
    return `${item.name}${opts ? ' / ' + opts : ''} / ${item.qty}개`;
  }).join('\n');

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const 주문일시 = `${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  await solapiSend(
    (order.phone || '').replace(/-/g, ''),
    SP_TEMPLATE_CODE,
    {
      '#{이름}'    : order.name   || '',
      '#{주문번호}': paymentData.orderId || order.orderId || '',
      '#{주문일시}': 주문일시,
      '#{상품목록}': itemLines || order.goodsName || '',
      '#{결제금액}': Number(paymentData.amount || order.total).toLocaleString('ko-KR') + '원',
      '#{결제수단}': methodLabel[paymentData.channel] || order.payment || '',
      '#{배송지}'  : order.address || '',
    }
  );
  console.log('[Solapi] 결제완료 알림톡 →', order.phone);
}

async function sendCancelAlimtalk(order, cancelledAt) {
  await solapiSend(
    order.phone.replace(/-/g, ''),
    SP_CANCEL_TEMPLATE_CODE,
    {
      '#{이름}'    : order.name || '',
      '#{주문번호}': order.order_id || '',
      '#{취소일시}': cancelledAt,
      '#{상품명}'  : order.goods_name || '',
      '#{환불금액}': Number(order.total_amount).toLocaleString('ko-KR') + '원',
    }
  );
  console.log('[Solapi] 취소 알림톡 →', order.phone);
}

// ── 서버 시작 ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Pokerfish 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`결제 승인 URL        → http://localhost:${PORT}/payment/approve`);
});
