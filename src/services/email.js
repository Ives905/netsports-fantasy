const nodemailer = require('nodemailer');

/**
 * Email service for sending verification codes and other emails
 */

// Create reusable transporter
const createTransporter = () => {
  // Check if email is configured
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER) {
    console.warn('Email not configured - EMAIL_HOST and EMAIL_USER required');
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });
};

/**
 * Send verification code email
 * @param {string} to - Recipient email address
 * @param {string} code - 6-digit verification code
 * @param {string} username - User's username
 * @returns {Promise<boolean>} - Success status
 */
async function sendVerificationEmail(to, code, username) {
  const transporter = createTransporter();

  if (!transporter) {
    console.error('Email transporter not configured - skipping email send');
    return false;
  }

  try {
    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: to,
      subject: 'Verify Your NetSports Fantasy Account',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #1a1a2e; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f4f4f4; padding: 30px; }
            .code { font-size: 32px; font-weight: bold; color: #16213e; background-color: #fff; padding: 15px; text-align: center; letter-spacing: 5px; margin: 20px 0; border-radius: 5px; }
            .footer { text-align: center; padding: 20px; font-size: 12px; color: #777; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🏒 NetSports Fantasy</h1>
            </div>
            <div class="content">
              <h2>Welcome, ${username}!</h2>
              <p>Thanks for signing up for NetSports Fantasy NHL Playoff Pool. To complete your registration, please verify your email address.</p>
              <p>Your verification code is:</p>
              <div class="code">${code}</div>
              <p>Enter this code on the verification page to activate your account.</p>
              <p>This code will expire in 24 hours.</p>
              <p>If you didn't create an account, you can safely ignore this email.</p>
            </div>
            <div class="footer">
              <p>NetSports Fantasy - NHL Playoff Pool</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
Welcome to NetSports Fantasy, ${username}!

Your verification code is: ${code}

Enter this code on the verification page to activate your account.

This code will expire in 24 hours.

If you didn't create an account, you can safely ignore this email.

---
NetSports Fantasy - NHL Playoff Pool
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Verification email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending verification email:', error);
    return false;
  }
}

module.exports = {
  sendVerificationEmail
};
