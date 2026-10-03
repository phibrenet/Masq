export const app = {
  getPath(name: string): string {
    if (name !== 'userData') throw new Error(`electron-shim: unsupported path "${name}"`)
    const dir = process.env.MASQ_TEST_USERDATA
    if (!dir) throw new Error('electron-shim: set MASQ_TEST_USERDATA to a throwaway directory')
    return dir
  }
}
