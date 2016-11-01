/**
 * @Copyright (c) Microsoft Corporation.  All rights reserved.
 */
import * as colors from 'colors';
import * as path from 'path';
import * as fsx from 'fs-extra';
import { EOL } from 'os';
import {
  CommandLineAction,
  CommandLineFlagParameter,
  CommandLineStringParameter
} from '@microsoft/ts-command-line';
import {
  IChangeInfo,
  ChangeType,
  RushConfig,
  RushConfigProject,
  Utilities
} from '@microsoft/rush-lib';
import RushCommandLineParser from './RushCommandLineParser';
import {
  IChangeInfoHash,
  findChangeRequests,
  sortChangeRequests,
  updatePackages
} from './publish';

export default class PublishAction extends CommandLineAction {
  private _apply: CommandLineFlagParameter;
  private _publish: CommandLineFlagParameter;
  private _targetBranch: CommandLineStringParameter;
  private _npmAuthToken: CommandLineStringParameter;
  private _rushConfig: RushConfig;
  private _parser: RushCommandLineParser;
  private _registryUrl: CommandLineStringParameter;

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'publish',
      summary:
      'Reads and processes package publishing change requests generated by "rush change". This is typically ' +
      'only executed by a CI workflow.',
      documentation:
      'Reads and processes package publishing change requests generated by "rush change". This will perform a ' +
      'read-only operation by default, printing operations executed to the console. To actually commit ' +
      'changes and publish packages, you must use the --commit flag.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._apply = this.defineFlagParameter({
      parameterLongName: '--apply',
      parameterShortName: '-a',
      description: 'If this flag is specified, the change requests will be applied to package.json files.'
    });
    this._targetBranch = this.defineStringParameter({
      parameterLongName: '--target-branch',
      parameterShortName: '-b',
      description:
      'If this flag is specified, applied changes and deleted change requests will be' +
      'committed and merged into the target branch.'
    });
    this._publish = this.defineFlagParameter({
      parameterLongName: '--publish',
      parameterShortName: '-p',
      description: 'If this flag is specified, applied changes will be published to npm.'
    });
    this._registryUrl = this.defineStringParameter({
      parameterLongName: '--registry',
      parameterShortName: '-r',
      description:
      `Publishes to a specified NPM registry. If this is specified, it will prevent the commit to be tagged.`
    });
    this._npmAuthToken = this.defineStringParameter({
      parameterLongName: '--npm-auth-token',
      parameterShortName: '-n',
      description:
      'Provide the default scope npm auth token to be passed into npm publish for global package publishing.'
    });
  }

  /**
   * Executes the publish action, which will read change request files, apply changes to package.jsons,
   */
  protected onExecute(): void {
    console.log(`Starting "rush publish" ${EOL}`);

    this._rushConfig = RushConfig.loadFromDefaultLocation();

    const changesPath: string = path.join(this._rushConfig.commonFolder, 'changes');
    const allPackages: Map<string, RushConfigProject> = this._rushConfig.projectsByName;
    const allChanges: IChangeInfoHash = findChangeRequests(allPackages, changesPath);
    const orderedChanges: IChangeInfo[] = sortChangeRequests(allChanges);

    if (orderedChanges.length > 0) {
      const tempBranch: string = 'publish-' + new Date().getTime();

      // Make changes in temp branch.
      this._gitCheckout(tempBranch, true);

      // Apply all changes to package.json files.
      updatePackages(allChanges, allPackages, this._apply.value);

      // Remove the change request files.
      this._deleteChangeFiles();

      // Stage, commit, and push the changes to remote temp branch.
      this._gitAddChanges();
      this._gitCommit();
      this._gitPush(tempBranch);

      // NPM publish the things that need publishing.
      for (const change of orderedChanges) {
        if (change.changeType > ChangeType.dependency) {
          this._npmPublish(change, allPackages.get(change.packageName).projectFolder);
        }
      }

      // Create and push appropriate git tags.
      this._gitAddTags(orderedChanges);
      this._gitPush(tempBranch);

      // Now merge to target branch.
      this._gitCheckout(this._targetBranch.value);
      this._gitPull();
      this._gitMerge(tempBranch);
      this._gitPush(this._targetBranch.value);
      this._gitDeleteBranch(tempBranch);
    }

    console.log(EOL + colors.green('Rush publish finished successfully.'));
  }

  private _getEnvArgs(): { [key: string]: string } {
    const env: { [key: string]: string } = {};

    // Copy existing process.env values (for nodist)
    Object.keys(process.env).forEach((key: string) => {
      env[key] = process.env[key];
    });
    return env;
  }

  private _execCommand(
    shouldExecute: boolean,
    command: string,
    args: string[] = [],
    workingDirectory: string = process.cwd(),
    env?: { [key: string]: string }
  ): void {

    let relativeDirectory: string = path.relative(process.cwd(), workingDirectory);
    const envArgs: { [key: string]: string } = this._getEnvArgs();

    if (relativeDirectory) {
      relativeDirectory = `(${relativeDirectory})`;
    }

    if (env) {
      Object.keys(env).forEach((name: string) => envArgs[name] = env[name]);
    }

    console.log(
      `${EOL}* ${shouldExecute ? 'EXECUTING' : 'DRYRUN'}: ${command} ${args.join(' ')} ${relativeDirectory}`
    );

    if (shouldExecute) {
      Utilities.executeCommand(
        command,
        args,
        workingDirectory,
        false,
        env);
    }
  }

  private _gitCheckout(branchName: string, createBranch?: boolean): void {
    const params: string = `checkout ${createBranch ? '-b ' : ''}${branchName}`;

    this._execCommand(!!this._targetBranch.value, 'git', params.split(' '));
  }

  private _gitMerge(branchName: string): void {
    this._execCommand(!!this._targetBranch.value, 'git', `merge ${branchName} --no-edit`.split(' '));
  }

  private _gitDeleteBranch(branchName: string): void {
    this._execCommand(!!this._targetBranch.value, 'git', `branch -d ${branchName}`.split(' '));
    this._execCommand(!!this._targetBranch.value, 'git', `push origin --delete ${branchName}`.split(' '));
  }

  private _gitPull(): void {
    this._execCommand(!!this._targetBranch.value, 'git', `pull origin ${this._targetBranch.value}`.split(' '));
  }

  private _deleteChangeFiles(): void {
    const changesPath: string = path.join(process.cwd(), 'changes');
    const shouldDelete: boolean = !!this._targetBranch.value;
    let changeFiles: string[] = [];

    try {
      changeFiles = fsx.readdirSync(changesPath).filter(filename => filename.indexOf('.json') >= 0);
    } catch (e) { /* no-op */ }

    if (changeFiles.length) {
      console.log(
        `${EOL}* ` +
        `${shouldDelete ? 'DELETING:' : 'DRYRUN: Deleting'} ` +
        `${changeFiles.length} change file(s).`
      );

      for (const fileName of changeFiles) {
        const filePath: string = path.join(changesPath, fileName);

        console.log(` - ${filePath}`);

        if (shouldDelete) {
          Utilities.deleteFile(filePath);
        }
      }
    }
  }

  private _gitAddChanges(): void {
    this._execCommand(!!this._targetBranch.value, 'git', ['add', '.']);
  }

  private _gitAddTags(orderedChanges: IChangeInfo[]): void {
    for (const change of orderedChanges) {

      if (change.changeType > ChangeType.dependency) {
        const tagName: string = change.packageName + '_v' + change.newVersion;

        // Tagging only happens if we're publishing to real NPM and committing to git.
        this._execCommand(
          !!this._targetBranch.value && !!this._publish.value && !this._registryUrl.value,
          'git',
          ['tag', '-a', tagName, '-m', `"${change.packageName} v${change.newVersion}"`]);
      }
    }
  }

  private _gitCommit(): void {
    this._execCommand(!!this._targetBranch.value, 'git', ['commit', '-m', '"Applying package updates."']);
  }

  private _gitPush(branchName: string): void {
    this._execCommand(
      !!this._targetBranch.value,
      'git',
      ['push', 'origin', 'HEAD:' + branchName, '--follow-tags', '--verbose']);
  }

  private _npmPublish(change: IChangeInfo, packagePath: string): void {
    const env: { [key: string]: string } = this._getEnvArgs();
    const args: string[] = [ 'publish' ];

    if (this._registryUrl.value) {
      env['npm_config_registry'] = this._registryUrl.value; // tslint:disable-line:no-string-literal
    }

    if (this._npmAuthToken.value) {
      args.push(`--//registry.npmjs.org/:_authToken=${this._npmAuthToken.value}`);
    }

    this._execCommand(
      !!this._publish.value,
      this._rushConfig.npmToolFilename,
      args,
      packagePath,
      env);
  }

}