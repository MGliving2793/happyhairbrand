const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const sendOrderConfirmationEmail = async (order, shipCorrectOrderNo) => {
  if (!order.email || order.email.trim() === '') {
    console.log('[MAILER] No email provided for order, skipping notification.');
    return;
  }

  const baseUrl = process.env.APP_URL || 'https://happy-hair-nutrition.vercel.app';
  const trackingLink = `${baseUrl}/api/orders/status/${order.id}`;

  const mailOptions = {
    from: `"Happy Hair" <${process.env.EMAIL_USER}>`,
    to: order.email,
    subject: `Order Confirmation - #${order.id}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
        <div style="background-color: #c99339; color: white; padding: 20px; text-align: center;">
          <h2 style="margin: 0;">Thank you for your order, ${order.customer_name}!</h2>
        </div>
        <div style="padding: 20px; background-color: #fdfbf7; color: #333;">
          <p>Your order has been successfully processed and dispatched for delivery.</p>
          
          <h3 style="border-bottom: 2px solid #c99339; padding-bottom: 5px; color: #1a361d;">Order Details</h3>
          <ul style="list-style-type: none; padding: 0;">
            <li style="margin-bottom: 10px;"><strong>Order ID:</strong> #${order.id}</li>
            <li style="margin-bottom: 10px;"><strong>Total Amount:</strong> ₹${order.total}</li>
            <li style="margin-bottom: 10px;"><strong>Payment Mode:</strong> ${order.pay_mode}</li>
            <li style="margin-bottom: 10px;"><strong>Shipping Reference / AWB:</strong> ${shipCorrectOrderNo || 'Generating...'}</li>
            <li style="margin-bottom: 10px;"><strong>Delivery Address:</strong> ${order.address}${order.city ? ', ' + order.city : ''}${order.pincode ? ' - ' + order.pincode : ''}</li>
          </ul>

          <div style="text-align: center; margin-top: 30px;">
            <a href="${trackingLink}" style="background-color: #1a361d; color: white; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block;">Track Your Order</a>
          </div>
        </div>
        <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #777;">
          <p style="margin: 0;">Thank you for shopping with Happy Hair!</p>
        </div>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[MAILER] Order confirmation email sent to ${order.email}`);
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[MAILER] Failed to send email to ${order.email}:`, error.message);
    }
  }
};

module.exports = { sendOrderConfirmationEmail };
