/**
 * @Copyright (c) Microsoft Corporation.  All rights reserved.
 */

import * as colors from 'colors';
import * as glob from 'glob';
import globEscape = require('glob-escape');
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import * as fsx from 'fs-extra';
import { CommandLineAction, CommandLineFlagParameter } from '@microsoft/ts-command-line';
import {
  AsyncRecycle,
  IPackageJson,
  JsonFile,
  RushConfig,
  RushConfigProject,
  Utilities,
  Stopwatch
} from '@microsoft/rush-lib';

import InstallAction from './InstallAction';
import RushCommandLineParser from './RushCommandLineParser';
import PackageReviewChecker from './PackageReviewChecker';

export default class GenerateAction extends CommandLineAction {
  private _parser: RushCommandLineParser;
  private _rushConfig: RushConfig;
  private _packageReviewChecker: PackageReviewChecker;
  private _lazyParameter: CommandLineFlagParameter;

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'generate',
      summary: 'Run this command after changing any project\'s package.json.',
      documentation: 'Run "rush regenerate" after changing any project\'s package.json.'
      + ' It scans the dependencies for all projects referenced in "rush.json", and then'
      + ' constructs a superset package.json in the Rush common folder.'
      + ' After running this command, you will need to commit your changes to git.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._lazyParameter = this.defineFlagParameter({
      parameterLongName: '--lazy',
      parameterShortName: '-l',
      description: 'Do not clean the "node_modules" folder before running "npm install".'
        + ' This is faster, but less correct, so only use it for debugging.'
    });
  }

  protected onExecute(): void {
    this._rushConfig = this._rushConfig = RushConfig.loadFromDefaultLocation();

    const stopwatch: Stopwatch = Stopwatch.start();

    console.log('Starting "rush generate"' + os.EOL);

    if (this._rushConfig.packageReviewFile) {
        this._packageReviewChecker = new PackageReviewChecker(this._rushConfig);
        this._packageReviewChecker.saveCurrentDependencies();
    }

    // 1. Delete "common\node_modules"
    const nodeModulesPath: string = path.join(this._rushConfig.commonFolder, 'node_modules');

    if (this._lazyParameter.value) {
      // In the lazy case, we keep the existing common/node_modules.  However, we need to delete
      // the temp projects (that were copied from common/temp_modules into common/node_modules).
      // We can recognize them because their names start with "rush-"
      console.log('Deleting common/node_modules/rush-*');
      const normalizedPath: string = Utilities.getAllReplaced(nodeModulesPath, '\\', '/');
      for (const tempModulePath of glob.sync(globEscape(normalizedPath) + '/rush-*')) {
        AsyncRecycle.recycleDirectory(this._rushConfig, tempModulePath);
      }
    } else {
      if (fsx.existsSync(nodeModulesPath)) {
        console.log('Deleting common/node_modules folder...');
        AsyncRecycle.recycleDirectory(this._rushConfig, nodeModulesPath);
      }
    }

    // 2. Delete "common\temp_modules"
    if (fsx.existsSync(this._rushConfig.tempModulesFolder)) {
      console.log('Deleting common/temp_modules folder');
      Utilities.dangerouslyDeletePath(this._rushConfig.tempModulesFolder);
    }

    // 3. Delete the previous npm-shrinkwrap.json
    const shrinkwrapFilename: string = path.join(this._rushConfig.commonFolder, 'npm-shrinkwrap.json');

    if (fsx.existsSync(shrinkwrapFilename)) {
      console.log('Deleting common/npm-shrinkwrap.json');
      Utilities.dangerouslyDeletePath(shrinkwrapFilename);
    }

    // 4. Construct common\package.json and common\temp_modules
    console.log('Creating a clean common/temp_modules folder');
    Utilities.createFolderWithRetry(this._rushConfig.tempModulesFolder);

    const commonPackageJson: PackageJson = {
      dependencies: {},
      description: 'Temporary file generated by the Rush tool',
      name: 'rush-common',
      private: true,
      version: '0.0.0'
    };

    console.log('Creating temp projects...');
    for (const rushProject of this._rushConfig.projects) {
      const packageJson: PackageJson = rushProject.packageJson;

      const tempProjectName: string = rushProject.tempProjectName;

      const tempProjectFolder: string = path.join(this._rushConfig.tempModulesFolder, tempProjectName);
      fsx.mkdirSync(tempProjectFolder);

      commonPackageJson.dependencies[tempProjectName] = 'file:./temp_modules/' + tempProjectName;

      const tempPackageJsonFilename: string = path.join(tempProjectFolder, 'package.json');

      const tempPackageJson: IPackageJson = {
        name: tempProjectName,
        version: '0.0.0',
        private: true,
        dependencies: {}
      };

      // If there are any optional dependencies, copy them over directly
      if (packageJson.optionalDependencies) {
        tempPackageJson.optionalDependencies = packageJson.optionalDependencies;
      }

      // Collect pairs of (packageName, packageVersion) to be added as temp package dependencies
      const pairs: { packageName: string, packageVersion: string }[] = [];

      // If there are devDependencies, we need to merge them with the regular
      // dependencies.  If the same library appears in both places, then the
      // regular dependency takes precedence over the devDependency.
      // It also takes precedence over a duplicate in optionalDependencies,
      // but NPM will take care of that for us.  (Frankly any kind of duplicate
      // should be an error, but NPM is pretty lax about this.)
      if (packageJson.devDependencies) {
        for (const packageName of Object.keys(packageJson.devDependencies)) {
          pairs.push({ packageName: packageName, packageVersion: packageJson.devDependencies[packageName] });
        }
      }

      if (packageJson.dependencies) {
        for (const packageName of Object.keys(packageJson.dependencies)) {
          pairs.push({ packageName: packageName, packageVersion: packageJson.dependencies[packageName] });
        }
      }

      for (const pair of pairs) {
        // Is there a locally built Rush project that could satisfy this dependency?
        // If so, then we will symlink to the project folder rather than to common/node_modules.
        // In this case, we don't want "npm install" to process this package, but we do need
        // to record this decision for "rush link" later, so we add it to a special 'rushDependencies' field.
        const localProject: RushConfigProject = this._rushConfig.getProjectByName(pair.packageName);
        if (localProject) {

          // Don't locally link if it's listed in the cyclicDependencyProjects
          if (!rushProject.cyclicDependencyProjects.has(pair.packageName)) {

            // Also, don't locally link if the SemVer doesn't match
            const localProjectVersion: string = localProject.packageJson.version;
            if (semver.satisfies(localProjectVersion, pair.packageVersion)) {

              // We will locally link this package
              if (!tempPackageJson.rushDependencies) {
                tempPackageJson.rushDependencies = {};
              }
              tempPackageJson.rushDependencies[pair.packageName] = pair.packageVersion;
              continue;
            }
          }
        }

        // We will NOT locally link this package; add it as a regular dependency.
        tempPackageJson.dependencies[pair.packageName] = pair.packageVersion;
      }

      JsonFile.saveJsonFile(tempPackageJson, tempPackageJsonFilename);
    }

    console.log('Writing common/package.json');
    const commonPackageJsonFilename: string = path.join(this._rushConfig.commonFolder, 'package.json');
    JsonFile.saveJsonFile(commonPackageJson, commonPackageJsonFilename);

    // 4. Make sure the NPM tool is set up properly.  Usually "rush install" should have
    //    already done this, but not if they just cloned the repo
    console.log('');
    InstallAction.ensureLocalNpmTool(this._rushConfig, false);

    // 5. Run "npm install" and "npm shrinkwrap"
    const npmInstallArgs: string[] = ['install'];
    if (this._rushConfig.cacheFolder) {
      npmInstallArgs.push('--cache', this._rushConfig.cacheFolder);
    }

    if (this._rushConfig.tmpFolder) {
      npmInstallArgs.push('--tmp', this._rushConfig.tmpFolder);
    }

    console.log(os.EOL + colors.bold(`Running "npm ${npmInstallArgs.join(' ')}"...`));
    Utilities.executeCommand(this._rushConfig.npmToolFilename, npmInstallArgs, this._rushConfig.commonFolder);
    console.log('"npm install" completed' + os.EOL);

    if (this._lazyParameter.value) {
      // If we're not doing it for real, then don't bother with "npm shrinkwrap"
      console.log(os.EOL + colors.bold('(Skipping "npm shrinkwrap")') + os.EOL);
    } else {
      console.log(os.EOL + colors.bold('Running "npm shrinkwrap"...'));
      Utilities.executeCommand(this._rushConfig.npmToolFilename, ['shrinkwrap' ], this._rushConfig.commonFolder);
      console.log('"npm shrinkwrap" completed' + os.EOL);
    }
    stopwatch.stop();
    console.log(os.EOL + colors.green(`Rush generate finished successfully. (${stopwatch.toString()})`));
    console.log(os.EOL + 'Next you should probably run: "rush link"');
  }
}
