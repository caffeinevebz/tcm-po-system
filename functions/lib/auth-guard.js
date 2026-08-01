const functions = require('firebase-functions/v1');

/**
 * Reject a callable request unless the caller signed in through verifyPin and
 * holds one of `allowed` roles.
 *
 * `scanInvoice` currently accepts calls from anyone on the internet, which means
 * a stranger can run up your AI bill. Once its source lives in this folder, add
 * two lines at the top of the handler:
 *
 *     const { requireRole } = require('./lib/auth-guard');
 *     ...
 *     exports.scanInvoice = functions.https.onCall(async (data, context) => {
 *       requireRole(context, ['owner', 'staff']);
 *       // ...existing implementation...
 *     });
 *
 * @param {object} context  the callable's context argument
 * @param {string[]} allowed roles permitted to call this function
 * @returns {string} the caller's role
 */
function requireRole(context, allowed) {
  const role = context && context.auth && context.auth.token && context.auth.token.role;
  if (!role || allowed.indexOf(role) === -1) {
    throw new functions.https.HttpsError('permission-denied', 'Not authorised.');
  }
  return role;
}

module.exports = { requireRole };
