export function shouldEnableCommandSocket(
  developmentMode: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return !developmentMode || Boolean(env.YACHIYO_DEV_CLI)
}
