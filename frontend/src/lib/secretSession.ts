let secretUnlocked = false;

export function unlockSecretSession(): void {
  secretUnlocked = true;
}

export function lockSecretSession(): void {
  secretUnlocked = false;
}

export function isSecretUnlocked(): boolean {
  return secretUnlocked;
}
