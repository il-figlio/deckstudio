// Browser stand-in for node:module: createRequire().resolve(id) maps a package file to /vendor/<id>.
export function createRequire(_from?: string) {
  const req = (id: string) => {
    throw new Error(`require(${id}) is not available in the browser`)
  }
  req.resolve = (id: string) => "/vendor/" + id
  return req
}
export default { createRequire }
