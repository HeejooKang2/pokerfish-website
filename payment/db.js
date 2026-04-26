const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'orders.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { return []; }
}

function save(orders) {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function phone4(phone) {
  return phone.replace(/-/g, '').slice(-4);
}

module.exports = {
  saveOrder: {
    run({ orderId, name, phone, address, items, goodsName, totalAmount,
          paymentMethod, paymentTid, message, createdAt }) {
      const orders = load();
      if (orders.find(o => o.order_id === orderId)) return;
      orders.unshift({
        order_id      : orderId,
        name, phone, address, items, message,
        goods_name    : goodsName,
        total_amount  : totalAmount,
        payment_method: paymentMethod,
        payment_tid   : paymentTid,
        status        : '결제완료',
        tracking_number: '',
        cancel_reason : '',
        cancelled_at  : '',
        created_at    : createdAt,
      });
      save(orders);
    },
  },

  findOrder: {
    get(orderId, p4) {
      return load().find(o => o.order_id === orderId && phone4(o.phone) === p4) || null;
    },
  },

  listOrders: {
    all() { return load(); },
  },

  getOrder: {
    get(orderId) {
      return load().find(o => o.order_id === orderId) || null;
    },
  },

  updateStatus: {
    run({ orderId, status, trackingNumber }) {
      const orders = load();
      const o = orders.find(o => o.order_id === orderId);
      if (!o) return;
      o.status          = status;
      o.tracking_number = trackingNumber;
      save(orders);
    },
  },

  cancelOrder: {
    run({ orderId, cancelReason, cancelledAt }) {
      const orders = load();
      const o = orders.find(o => o.order_id === orderId);
      if (!o) return;
      o.status        = '취소완료';
      o.cancel_reason = cancelReason;
      o.cancelled_at  = cancelledAt;
      save(orders);
    },
  },
};
