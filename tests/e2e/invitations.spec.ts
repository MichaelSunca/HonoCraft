import {test,expect,password} from './fixtures.js';
import {invitation} from '../helpers/invitation.js';
import {initializedDatabase} from '../helpers/identity.js';

test('invitation preview and explicit acceptance activate the account without leaking the token',async({page,backend})=>{
  await initializedDatabase(backend.pool);const invite=await invitation(backend.pool,{epoch:'browser-test-epoch'}),requests:string[]=[];
  page.on('request',request=>requests.push(request.url()));await page.setViewportSize({width:360,height:800});
  await page.goto(backend.origin+'/accept-invite#token='+invite.token);await expect(page.getByRole('heading',{name:'Accept invitation',exact:true})).toBeVisible();await expect(page.getByText(invite.email,{exact:true})).toBeVisible();await expect(page).toHaveURL(backend.origin+'/accept-invite');
  expect((await backend.pool.query('SELECT consumed_at FROM one_time_credentials WHERE id=$1',[invite.credentialId])).rows[0].consumed_at).toBeNull();
  await page.getByLabel('Display name',{exact:true}).fill('Invited browser member');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Accept invitation',exact:true}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await expect(page.getByRole('status')).toContainText('Invitation accepted');
  expect((await backend.pool.query('SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE normalized_email=$1',[invite.email])).rowCount).toBe(0);
  await page.getByLabel('Email',{exact:true}).fill(invite.email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Your workspace'})).toBeVisible();
  expect(requests.some(url=>url.includes(invite.token))).toBe(false);expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('a role change after preview requires a new invitation and clears password inputs',async({page,backend})=>{
  await initializedDatabase(backend.pool);const invite=await invitation(backend.pool,{epoch:'browser-test-epoch'});
  await page.goto(backend.origin+'/accept-invite#token='+invite.token);await expect(page.getByText(invite.email,{exact:true})).toBeVisible();
  await backend.pool.query("UPDATE roles SET name='Changed name',version=version+1 WHERE code='user'");
  await page.getByLabel('Display name',{exact:true}).fill('Draft member');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);await page.getByRole('button',{name:'Accept invitation',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Ask an administrator to resend');await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Draft member');
  expect((await backend.pool.query('SELECT status FROM invites WHERE id=$1',[invite.id])).rows[0].status).toBe('pending');
});
test('refresh discards the invitation token while leaving the invitation pending',async({page,backend})=>{
  await initializedDatabase(backend.pool);const invite=await invitation(backend.pool,{epoch:'browser-test-epoch'});
  await page.goto(backend.origin+'/accept-invite#token='+invite.token);await expect(page.getByText(invite.email,{exact:true})).toBeVisible();await page.reload();
  await expect(page.getByRole('alert')).toContainText('Open the original email link');expect((await backend.pool.query('SELECT consumed_at FROM one_time_credentials WHERE id=$1',[invite.credentialId])).rows[0].consumed_at).toBeNull();
});
test('preview network failures offer an explicit retry without submitting the acceptance',async({page,backend})=>{
  await initializedDatabase(backend.pool);const invite=await invitation(backend.pool,{epoch:'browser-test-epoch'});
  await page.route('**/api/v1/auth/invites/preview',route=>route.abort(),{times:1});await page.goto(backend.origin+'/accept-invite#token='+invite.token);
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');await expect(page.getByRole('button',{name:'Accept invitation',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByText(invite.email,{exact:true})).toBeVisible();
  expect((await backend.pool.query('SELECT consumed_at FROM one_time_credentials WHERE id=$1',[invite.credentialId])).rows[0].consumed_at).toBeNull();
});
