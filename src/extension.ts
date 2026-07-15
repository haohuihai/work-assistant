import * as vscode from 'vscode'
import { activateSwaggerHelper } from './swaggerHelper'
import { registerRightClickMenu } from './rightClickMenu'
import { activateGitReview } from './gitReview'

export function activate(context: vscode.ExtensionContext) {
  activateSwaggerHelper(context)
  registerRightClickMenu(context)
  activateGitReview(context)
}

export function deactivate() { }
