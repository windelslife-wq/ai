<?php
/**
 * ACCOUNT MANAGEMENT — registration username, six-digit User ID, sign-in by
 * username/email/User ID, and self-service profile editing (username, email,
 * password, profile image) with a stable permanent User ID.
 */

test('createUser generates a unique username and a six-digit User ID', function () {
    $p = platform();
    $email = 'am-' . uniqid() . '@example.com';
    $now = gmdate('c');
    $user = $p->model->identity->createUser([
        'email' => $email,
        'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT),
        'display_name' => 'Amy Test',
        'active' => 1, 'created_at' => $now, 'updated_at' => $now, 'last_login_at' => $now,
    ]);
    assert_true(!empty($user['username']), 'username auto-generated');
    assert_true((bool) preg_match('/^[a-z][a-z0-9_]{2,19}$/', (string) $user['username']), 'username matches policy');
    assert_true(!empty($user['user_uid']), 'User ID auto-generated');
    assert_true((bool) preg_match('/^\d{6}$/', (string) $user['user_uid']), 'User ID is exactly six digits');
    assert_true((int) $user['id'] > 0, 'internal primary key present');
    // The six-digit User ID is a separate, public identifier — not the DB id.
    assert_true((string) $user['user_uid'] !== (string) $user['id'], 'User ID is distinct from the DB id');
});

test('identifiers: login works via username, email OR six-digit User ID', function () {
    $p = platform();
    $email = 'am-' . uniqid() . '@example.com';
    $pass = 'long-password-123456';
    $now = gmdate('c');
    $user = $p->model->identity->createUser([
        'email' => $email, 'password_hash' => password_hash($pass, PASSWORD_DEFAULT),
        'display_name' => 'Ida Test', 'active' => 1,
        'created_at' => $now, 'updated_at' => $now, 'last_login_at' => $now,
    ]);
    $username = (string) $user['username'];
    $uid = (string) $user['user_uid'];
    foreach ([$email, $username, $uid] as $identifier) {
        $authed = $p->identity->authenticate($identifier, $pass);
        assert_not_null($authed, "authenticate via '$identifier'");
        assert_false(isset($authed['password_hash']), 'password hash never returned');
    }
    assert_null($p->identity->authenticate($username, 'wrong-password'), 'wrong password rejected');
});

test('lookup: findUserByIdentifier routes email, username and User ID correctly', function () {
    $p = platform();
    $email = 'am-' . uniqid() . '@example.com';
    $now = gmdate('c');
    $user = $p->model->identity->createUser([
        'email' => $email, 'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT),
        'display_name' => 'Lou Test', 'active' => 1,
        'created_at' => $now, 'updated_at' => $now, 'last_login_at' => $now,
    ]);
    $byEmail = $p->model->identity->findUserByIdentifier($email);
    $byName = $p->model->identity->findUserByIdentifier((string) $user['username']);
    $byUid = $p->model->identity->findUserByIdentifier((string) $user['user_uid']);
    assert_true((int) $byEmail['id'] === (int) $user['id']);
    assert_true((int) $byName['id'] === (int) $user['id']);
    assert_true((int) $byUid['id'] === (int) $user['id']);
    assert_null($p->model->identity->findUserByIdentifier('not-a-real-user'));
});

test('username and email uniqueness checks exclude the user themselves', function () {
    $p = platform();
    $email = 'am-' . uniqid() . '@example.com';
    $now = gmdate('c');
    $a = $p->model->identity->createUser(['email' => $email, 'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT), 'display_name' => 'Uno', 'active' => 1, 'created_at' => $now, 'updated_at' => $now]);
    $b = $p->model->identity->createUser(['email' => 'am-' . uniqid() . '@example.com', 'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT), 'display_name' => 'Dos', 'active' => 1, 'created_at' => $now, 'updated_at' => $now]);
    // The other user's username / email is taken.
    assert_true($p->model->identity->usernameTaken((string) $b['username']), 'other username is taken');
    assert_true($p->model->identity->emailTaken((string) $b['email']), 'other email is taken');
    // Excluding their own id means their own username/email are not "taken".
    assert_false($p->model->identity->usernameTaken((string) $b['username'], (int) $b['id']), 'own username not taken for self');
    assert_false($p->model->identity->emailTaken((string) $b['email'], (int) $b['id']), 'own email not taken for self');
});

test('self-service editing keeps the six-digit User ID stable and updates fields', function () {
    $p = platform();
    $email = 'am-' . uniqid() . '@example.com';
    $now = gmdate('c');
    $user = $p->model->identity->createUser(['email' => $email, 'password_hash' => password_hash('long-password-123456', PASSWORD_DEFAULT), 'display_name' => 'Ed Test', 'active' => 1, 'created_at' => $now, 'updated_at' => $now]);
    $origUid = (string) $user['user_uid'];

    // Change username
    $p->model->identity->updateUser((int) $user['id'], ['username' => 'editedname', 'display_name' => 'editedname']);
    // Change email
    $newEmail = 'am-' . uniqid() . '@example.com';
    $p->model->identity->updateUser((int) $user['id'], ['email' => $newEmail]);
    // Change password
    $p->model->identity->updateUser((int) $user['id'], ['password_hash' => password_hash('a-brand-new-password-999', PASSWORD_DEFAULT)]);
    // Set profile image
    $p->model->identity->updateUser((int) $user['id'], ['profile_image' => '/assets/uploads/avatars/u1_abc.png']);

    $fresh = $p->model->identity->findUserById((int) $user['id']);
    assert_equals('editedname', (string) $fresh['username']);
    assert_equals($newEmail, (string) $fresh['email']);
    assert_equals($origUid, (string) $fresh['user_uid'], 'User ID remains stable across profile edits');
    assert_equals('/assets/uploads/avatars/u1_abc.png', (string) $fresh['profile_image']);
    // The new password authenticates; the old one does not.
    assert_not_null($p->identity->authenticate($newEmail, 'a-brand-new-password-999'));
    assert_null($p->identity->authenticate($newEmail, 'long-password-123456'));
});

test('generateUniqueUid always returns 6 digits and generateUniqueUsername is available', function () {
    $p = platform();
    for ($i = 0; $i < 20; $i++) {
        $uid = $p->model->identity->generateUniqueUid();
        assert_true((bool) preg_match('/^\d{6}$/', $uid), 'uid exactly six digits');
    }
    $uname = $p->model->identity->generateUniqueUsername('Amy Test');
    assert_true((bool) preg_match('/^[a-z][a-z0-9_]{2,19}$/', $uname));
    $uname2 = $p->model->identity->generateUniqueUsername('99');
    assert_true((bool) preg_match('/^[a-z][a-z0-9_]{2,19}$/', $uname2));
});
