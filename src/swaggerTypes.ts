export type ApiItem = {
  path: string
  method: string
  reqJson: any
  resJson: any
}

export type ProjectItem = {
  id: string
  title: string
  url: string
  apis: ApiItem[]
  updatedAt: number
}
