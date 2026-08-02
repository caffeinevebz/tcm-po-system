/**
 * End-to-end tests for the sign-in Cloud Functions, run against the Firestore
 * and Auth emulators.
 *
 *   npm install --save-dev firebase-functions-test
 *   npm run test:auth
 *
 * These walk the journeys a real person takes — first registration, setting a
 * PIN, coming back the next day — because the bug that made the owner re-do the
 * SMS code every time was only visible across two calls: claimRole reported
 * hasPin for staff but not for the owner.
 */
process.env.GCLOUD_PROJECT='demo-tcm'; process.env.OWNER_PHONE='+919876500001';
process.env.OWNER_EMAIL='owner@caffeine.test';
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8085'; process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099';
const ftest=(await import('firebase-functions-test')).default({projectId:'demo-tcm'});
const admin=(await import('firebase-admin')).default;
const fns=await import('../functions/index.js');
const w=f=>ftest.wrap(f);
const ok=(l,v)=>console.log('  ✓ '+l+(v!==undefined?': '+JSON.stringify(v):''));
const bad=(l,e)=>console.log('  ✗ '+l+' -> '+(e.code||'')+' '+e.message);
const pctx=(u,extra={})=>({auth:{uid:u.uid,token:{phone_number:u.phoneNumber,...extra}}});
const ectx=(u,extra={})=>({auth:{uid:u.uid,token:{email:u.email,email_verified:true,...extra}}});

console.log('\n=== OWNER via mobile ===');
const o=await admin.auth().createUser({phoneNumber:'+919876500001'});
try{ok('1. claimRole after OTP (first ever)',await w(fns.claimRole)({},pctx(o)));}catch(e){bad('claimRole',e)}
try{ok('2. setPin',await w(fns.setPin)({pin:'481902'},pctx(o,{role:'owner'})));}catch(e){bad('setPin',e)}
try{ok('3. claimRole again — hasPin must be TRUE now',await w(fns.claimRole)({},pctx(o)));}catch(e){bad('claimRole',e)}
try{const r=await w(fns.pinSignIn)({phone:'+919876500001',pin:'481902'},{rawRequest:{ip:'1.1.1.1'}});ok('4. next visit: number + PIN',{role:r.role,token:!!r.token});}catch(e){bad('pinSignIn',e)}
try{ok('5. sessionState (returning, session alive)',await w(fns.sessionState)({},pctx(o,{role:'owner'})));}catch(e){bad('sessionState',e)}
try{await w(fns.pinSignIn)({phone:'+919876500001',pin:'999999'},{rawRequest:{ip:'1.1.1.9'}});console.log('  ✗ wrong PIN was ACCEPTED');}catch(e){ok('6. wrong PIN rejected',e.code)}

console.log('\n=== OWNER via email ===');
const oe=await admin.auth().createUser({email:'owner@caffeine.test',emailVerified:true});
try{ok('1. claimRole after email link',await w(fns.claimRole)({},ectx(oe)));}catch(e){bad('claimRole',e)}
try{ok('2. setPin',await w(fns.setPin)({pin:'552211'},ectx(oe,{role:'owner'})));}catch(e){bad('setPin',e)}
try{const r=await w(fns.pinSignIn)({email:'owner@caffeine.test',pin:'552211'},{rawRequest:{ip:'2.2.2.2'}});ok('3. next visit: email + PIN',{role:r.role,token:!!r.token});}catch(e){bad('pinSignIn',e)}

console.log('\n=== a stranger with a verified email ===');
const x=await admin.auth().createUser({email:'nobody@example.com',emailVerified:true});
try{const r=await w(fns.claimRole)({},ectx(x));console.log('  ✗ stranger ADMITTED:',JSON.stringify(r));}catch(e){ok('refused',e.code+' '+e.message)}

console.log('\n=== STAFF ===');
try{await w(fns.inviteStaff)({phone:'9876500002',name:'Rahul'},pctx(o,{role:'owner'}));}catch(e){bad('invite',e)}
const st=await admin.auth().createUser({phoneNumber:'+919876500002'});
try{ok('1. claimRole after OTP',await w(fns.claimRole)({},pctx(st)));}catch(e){bad('claimRole',e)}
try{await w(fns.setPin)({pin:'730514'},pctx(st,{role:'staff'}));ok('2. setPin');}catch(e){bad('setPin',e)}
try{ok('3. claimRole again — hasPin TRUE',await w(fns.claimRole)({},pctx(st)));}catch(e){bad('claimRole',e)}
try{const r=await w(fns.pinSignIn)({phone:'+919876500002',pin:'730514'},{rawRequest:{ip:'3.3.3.3'}});ok('4. number + PIN',{role:r.role});}catch(e){bad('pinSignIn',e)}
ftest.cleanup(); process.exit(0);
