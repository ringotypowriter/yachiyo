export function initiateQuitAndInstall(quitAndInstall: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      try {
        quitAndInstall()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
}
