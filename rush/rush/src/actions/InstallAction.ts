/**
 * @Copyright (c) Microsoft Corporation.  All rights reserved.
 */

import * as colors from 'colors';
import * as fsx from 'fs-extra';
import * as glob from 'glob';
import globEscape = require('glob-escape');
import * as os from 'os';
import * as path from 'path';
import { CommandLineAction, CommandLineFlagParameter } from '@microsoft/ts-command-line';
import {
  JsonFile,
  RushConfig,
  Utilities,
  Stopwatch
} from '@microsoft/rush-lib';

import RushCommandLineParser from './RushCommandLineParser';

const MAX_INSTALL_ATTEMPTS: number = 5;

export default class InstallAction extends CommandLineAction {
  private _parser: RushCommandLineParser;
  private _rushConfig: RushConfig;
  private _cleanInstall: CommandLineFlagParameter;
  private _cleanInstallFull: CommandLineFlagParameter;

  public static ensureLocalNpmTool(rushConfig: RushConfig, cleanInstall: boolean): void {
    // Example: "C:\Users\YourName\.rush"
    const rushHomeFolder: string = path.join(rushConfig.homeFolder, '.rush');

    if (!fsx.existsSync(rushHomeFolder)) {
      console.log('Creating ' + rushHomeFolder);
      fsx.mkdirSync(rushHomeFolder);
    }

    // Example: "C:\Users\YourName\.rush\npm-1.2.3"
    const npmToolFolder: string = path.join(rushHomeFolder, 'npm-' + rushConfig.npmToolVersion);
    // Example: "C:\Users\YourName\.rush\npm-1.2.3\last-install.log"
    const npmToolFlagFile: string = path.join(npmToolFolder, 'last-install.log');

    // NOTE: We don't care about the timestamp for last-install.log, because nobody will change
    // the package.json for this case
    if (cleanInstall || !fsx.existsSync(npmToolFlagFile)) {
      console.log(colors.bold('Installing NPM version ' + rushConfig.npmToolVersion) + os.EOL);

      if (fsx.existsSync(npmToolFolder)) {
        console.log('Deleting old files from ' + npmToolFolder);
        Utilities.dangerouslyDeletePath(npmToolFolder);
      }
      Utilities.createFolderWithRetry(npmToolFolder);

      const npmPackageJson: PackageJson = {
        dependencies: { 'npm': rushConfig.npmToolVersion },
        description: 'Temporary file generated by the Rush tool',
        name: 'npm-local-install',
        private: true,
        version: '0.0.0'
      };
      JsonFile.saveJsonFile(npmPackageJson, path.join(npmToolFolder, 'package.json'));

      console.log(os.EOL + 'Running "npm install" in ' + npmToolFolder);

      // NOTE: Here we use whatever version of NPM we happen to find in the PATH
      Utilities.executeCommandWithRetry('npm', ['install'], MAX_INSTALL_ATTEMPTS, npmToolFolder);

      // Create the marker file to indicate a successful install
      fsx.writeFileSync(npmToolFlagFile, '');
      console.log('Successfully installed NPM ' + rushConfig.npmToolVersion);
    } else {
      console.log('Found NPM version ' + rushConfig.npmToolVersion + ' in ' + npmToolFolder);
    }

    // Example: "C:\MyRepo\common\npm-local"
    const localNpmToolFolder: string = path.join(rushConfig.commonFolder, 'npm-local');
    if (fsx.existsSync(localNpmToolFolder)) {
      fsx.unlinkSync(localNpmToolFolder);
    }
    console.log(os.EOL + 'Symlinking "' + localNpmToolFolder + '"');
    console.log('  --> "' + npmToolFolder + '"');
    fsx.symlinkSync(npmToolFolder, localNpmToolFolder, 'junction');
  }

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'install',
      summary: 'Install NPM packages as specified by the config files in the Rush "common" folder',
      documentation: 'Use this command after pulling new changes from git into your working folder.'
        + ' It will download and install the appropriate NPM packages needed to build your projects.'
        + ' The complete sequence is as follows:  1. If not already installed, install the'
        + ' version of the NPM tool that is specified in the rush.json config file.  2. Create the'
        + ' common/npm-local symlink, which points to the folder from #1.  3. If necessary, run'
        + ' "npm prune" in the Rush common folder.  4. If necessary, run "npm install" in the'
        + ' Rush common folder.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._cleanInstall = this.defineFlagParameter({
      parameterLongName: '--clean',
      parameterShortName: '-c',
      description: 'Delete any previously installed files before installing;'
      + ' this takes longer but will resolve data corruption that is often'
      + ' encountered with the NPM tool'
    });
    this._cleanInstallFull = this.defineFlagParameter({
      parameterLongName: '--full-clean',
      parameterShortName: '-C',
      description: 'Like "--clean", but also deletes and reinstalls the NPM tool itself'
    });
  }

  protected onExecute(): void {
    this._rushConfig = RushConfig.loadFromDefaultLocation();

    const stopwatch: Stopwatch = Stopwatch.start();

    console.log('Starting "rush install"' + os.EOL);

    InstallAction.ensureLocalNpmTool(this._rushConfig, this._cleanInstallFull.value);
    this._installCommonModules();

    stopwatch.stop();
    console.log(colors.green(`The common NPM packages are up to date. (${stopwatch.toString()})`));
    console.log(os.EOL + 'Next you should probably run: "rush link"');
  }

  private _installCommonModules(): void {
    // Example: "C:\MyRepo\common\npm-local\node_modules\.bin\npm"
    const npmToolFilename: string = this._rushConfig.npmToolFilename;
    if (!fsx.existsSync(npmToolFilename)) {
      // This is a sanity check.  It should never happen if the above logic worked correctly.
      throw new Error('Failed to create "' + npmToolFilename + '"');
    }

    console.log(os.EOL + colors.bold('Checking modules in ' + this._rushConfig.commonFolder) + os.EOL);

    // Example: "C:\MyRepo\common\last-install.log"
    const commonNodeModulesFlagFilename: string = path.join(this._rushConfig.commonFolder, 'last-install.log');
    const commonNodeModulesFolder: string = path.join(this._rushConfig.commonFolder, 'node_modules');

    let needToInstall: boolean = false;
    let skipPrune: boolean = false;

    if (this._cleanInstall.value || this._cleanInstallFull.value) {
      if (fsx.existsSync(commonNodeModulesFlagFilename)) {
        // If we are cleaning the node_modules folder, then also delete the flag file
        // to force a reinstall
        fsx.unlinkSync(commonNodeModulesFlagFilename);
      }

      // Example: "C:\MyRepo\common\node_modules"
      if (fsx.existsSync(commonNodeModulesFolder)) {
        console.log('Deleting old files from ' + commonNodeModulesFolder);
        Utilities.dangerouslyDeletePath(commonNodeModulesFolder);
        Utilities.createFolderWithRetry(commonNodeModulesFolder);
      }

      if (!this._rushConfig.cacheFolder) {
        const cacheCleanArgs: string[] = ['cache', 'clean', this._rushConfig.cacheFolder];
        console.log(os.EOL + `Running "npm ${cacheCleanArgs.join(' ')}"`);
        Utilities.executeCommand(npmToolFilename, cacheCleanArgs, this._rushConfig.commonFolder);
      } else {
        console.log(os.EOL + 'Skipping "npm cache clean" because the cache is global.');
      }

      needToInstall = true;
      skipPrune = true;
    } else {
      // Compare the timestamps last-install.log and package.json to see if our install is outdated
      const packageJsonFilenames: string[] = [];

      // Example: "C:\MyRepo\common\package.json"
      packageJsonFilenames.push(path.join(this._rushConfig.commonFolder, 'package.json'));

      // Also consider the timestamp on the node_modules folder; if someone tampered with it
      // or deleted it entirely, then isFileTimestampCurrent() will cause us to redo "npm install".
      packageJsonFilenames.push(commonNodeModulesFolder);

      // Example: "C:\MyRepo\common\temp_modules\rush-example-project\package.json"
      const normalizedPath: string = Utilities.getAllReplaced(this._rushConfig.tempModulesFolder, '\\', '/');
      const globPattern: string = globEscape(normalizedPath)
        + '/rush-*/package.json';
      packageJsonFilenames.push(...glob.sync(globPattern, { nodir: true }));

      if (!Utilities.isFileTimestampCurrent(commonNodeModulesFlagFilename, packageJsonFilenames)) {
        needToInstall = true;
      }
    }

    if (needToInstall) {
      // Rush install is transactional, so if the process is killed while it's in-progress, the
      //  common/node_modules directory won't be invalid. The process follows this sequence:
      //   1. The common/npm-install-temp directory is deleted if it already exists
      //   2. A new common/npm-install-temp directory is created
      //   3. If a common/node_modules directory already exists, it's moved into the
      //        npm-install-temp directory
      //   4. The package.json fole and the common/temp_modules directory are copied into
      //        the npm-install-temp directory
      //   5. `npm prune` is optionally run in the npm-install-temp directory
      //   6. `npm install` is run in the npm-install-temp directory
      //   7. The now-complete the npm-install-temp/node_modules directory is moved back to
      //        the common directory (so now we have a complete common/node_modules directory)
      //
      // Because the move operation is atomic, if the process is killed during any of these steps,
      //  an incomplete or invalid node_modules directory will be under the npm-install-temp directory,
      //  and not in the common directory. The next time Rush install runs, the invalid
      //  npm-install-temp/node_modules directory is deleted, so the repository is never in an invalid state.
      const npmTempInstallDirectory: string = path.join(this._rushConfig.commonFolder, 'npm-install-temp');
      const tempNodeModulesPath: string = path.join(npmTempInstallDirectory, 'node_modules');
      if (fsx.existsSync(npmTempInstallDirectory)) {
        console.log(`Deleting ${npmTempInstallDirectory}`);
        Utilities.dangerouslyDeletePath(npmTempInstallDirectory);
      }

      console.log(`Creating ${npmTempInstallDirectory}`);
      Utilities.createFolderWithRetry(npmTempInstallDirectory);

      if (fsx.existsSync(commonNodeModulesFolder)) {
        console.log(`Moving existing common node_modules folder to ${tempNodeModulesPath}`);
        fsx.renameSync(commonNodeModulesFolder, tempNodeModulesPath);
      }

      console.log(`Copying package.json files to ${npmTempInstallDirectory}`);
      fsx.copySync(path.join(this._rushConfig.commonFolder, 'package.json'),
                  path.join(npmTempInstallDirectory, 'package.json'));
      fsx.copySync(this._rushConfig.tempModulesFolder,
                  path.join(npmTempInstallDirectory, path.basename(this._rushConfig.tempModulesFolder)));

      if (!skipPrune) {
        console.log(`Running "npm prune" in ${npmTempInstallDirectory}`);
        Utilities.executeCommandWithRetry(npmToolFilename, ['prune'], MAX_INSTALL_ATTEMPTS,
          npmTempInstallDirectory);

        // Delete the temp projects because NPM will not notice when they are changed.
        // We can recognize them because their names start with "rush-"
        console.log(`Deleting ${npmTempInstallDirectory}/node_modules/rush-*`);
        // Example: "C:\MyRepo\common\node_modules\rush-example-project"
        const normalizedPath: string = Utilities.getAllReplaced(npmTempInstallDirectory, '\\', '/');
        for (const tempModulePath of glob.sync(globEscape(normalizedPath) + '/rush-*')) {
          Utilities.dangerouslyDeletePath(tempModulePath);
        }
      }

      const npmInstallArgs: string[] = ['install'];
      if (this._rushConfig.cacheFolder) {
        npmInstallArgs.push('--cache', this._rushConfig.cacheFolder);
      }

      if (this._rushConfig.tmpFolder) {
        npmInstallArgs.push('--tmp', this._rushConfig.tmpFolder);
      }

      // Next, run "npm install" in the common folder
      console.log(os.EOL + `Running "npm ${npmInstallArgs.join(' ')}" in ${npmTempInstallDirectory}`);
      Utilities.executeCommandWithRetry(npmToolFilename,
                                        npmInstallArgs,
                                        MAX_INSTALL_ATTEMPTS,
                                        npmTempInstallDirectory);

      console.log(`Moving ${tempNodeModulesPath} to ${commonNodeModulesFolder}`);
      fsx.renameSync(tempNodeModulesPath, commonNodeModulesFolder);

      // Create the marker file to indicate a successful install
      fsx.writeFileSync(commonNodeModulesFlagFilename, '');
      console.log('');
    }

  }
}
