import * as vscode from 'vscode';
import { GdxSymbol } from '../duckdb/duckdbService';

export class GdxSymbolTreeProvider implements vscode.TreeDataProvider<GdxSymbolItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GdxSymbolItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private symbols: GdxSymbol[] = [];

  constructor() {
    // No document manager dependency - symbols are set directly
  }

  setSymbols(symbols: GdxSymbol[]): void {
    this.symbols = symbols;
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: GdxSymbolItem): vscode.TreeItem {
    return element;
  }

  getChildren(): GdxSymbolItem[] {
    return this.symbols.map(symbol => new GdxSymbolItem(symbol));
  }
}

export class GdxSymbolItem extends vscode.TreeItem {
  constructor(public readonly symbol: GdxSymbol) {
    super(symbol.name, vscode.TreeItemCollapsibleState.None);

    // Set description: dimensions and record count
    this.description = `${symbol.dimensionCount}D · ${symbol.recordCount.toLocaleString()} records`;

    // Set icon based on symbol type
    this.iconPath = this.getIconForType(symbol.type);

    // Set tooltip with more details
    this.tooltip = `${symbol.name}\nType: ${symbol.type}\nDimensions: ${symbol.dimensionCount}\nRecords: ${symbol.recordCount.toLocaleString()}`;

    // Set context value for context menu commands
    this.contextValue = 'gdxSymbol';

    // Make clickable
    this.command = {
      command: 'gdxViewer.selectSymbol',
      title: 'Select Symbol',
      arguments: [symbol],
    };
  }

  private getIconForType(type: string): vscode.ThemeIcon {
    switch (type.toLowerCase()) {
      case 'set':
        return new vscode.ThemeIcon('symbol-enum');
      case 'parameter':
        return new vscode.ThemeIcon('symbol-numeric');
      case 'variable':
        return new vscode.ThemeIcon('symbol-variable');
      case 'equation':
        return new vscode.ThemeIcon('symbol-operator');
      case 'alias':
        return new vscode.ThemeIcon('symbol-reference');
      default:
        return new vscode.ThemeIcon('symbol-misc');
    }
  }
}
