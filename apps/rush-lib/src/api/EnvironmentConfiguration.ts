// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import * as path from 'path';
import { trueCasePathSync } from 'true-case-path';

/**
 * Names of environment variables used by Rush.
 * @public
 */
export const enum EnvironmentVariableNames {
  /**
   * This variable overrides the temporary folder used by Rush.
   * The default value is "common/temp" under the repository root.
   */
  RUSH_TEMP_FOLDER = 'RUSH_TEMP_FOLDER',

  /**
   * This variable overrides the version of Rush that will be installed by
   * the version selector.  The default value is determined by the "rushVersion"
   * field from rush.json.
   */
  RUSH_PREVIEW_VERSION = 'RUSH_PREVIEW_VERSION',

  /**
   * If this variable is set to "true", Rush will not fail the build when running a version
   * of Node that does not match the criteria specified in the "nodeSupportedVersionRange"
   * field from rush.json.
   */
  RUSH_ALLOW_UNSUPPORTED_NODEJS = 'RUSH_ALLOW_UNSUPPORTED_NODEJS',

  /**
   * This variable selects a specific installation variant for Rush to use when installing
   * and linking package dependencies.  For more information, see this article:
   * https://rushjs.io/pages/advanced/installation_variants/
   */
  RUSH_VARIANT = 'RUSH_VARIANT',

  /**
   * If this variable is set to "true", Rush will create symlinks with absolute paths instead
   * of relative paths. This can be necessary when a repository is moved during a build or
   * if parts of a repository are moved into a sandbox.
   */
  RUSH_ABSOLUTE_SYMLINKS = 'RUSH_ABSOLUTE_SYMLINKS'
}

/**
 * Provides Rush-specific environment variable data. All Rush environment variables must start with "RUSH_". This class
 * is designed to be used by RushConfiguration.
 *
 * @remarks
 * Initialize will throw if any unknown parameters are present.
 */
export class EnvironmentConfiguration {
  private static _hasBeenInitialized: boolean = false;

  private static _rushTempFolderOverride: string | undefined;

  private static _absoluteSymlinks: boolean = false;

  private static _allowUnsupportedNodeVersion: boolean = false;

  /**
   * An override for the common/temp folder path.
   */
  public static get rushTempFolderOverride(): string | undefined {
    EnvironmentConfiguration._ensureInitialized();
    return EnvironmentConfiguration._rushTempFolderOverride;
  }

  /**
   * If "true", create symlinks with absolute paths instead of relative paths.
   * See {@link EnvironmentVariableNames.RUSH_ABSOLUTE_SYMLINKS}
   */
  public static get absoluteSymlinks(): boolean {
    EnvironmentConfiguration._ensureInitialized();
    return EnvironmentConfiguration._absoluteSymlinks;
  }

  /**
   * If this environment variable is set to "true", the Node.js version check will print a warning
   * instead of causing a hard error if the environment's Node.js version doesn't match the
   * version specifier in `rush.json`'s "nodeSupportedVersionRange" property.
   *
   * See {@link EnvironmentVariableNames.RUSH_ALLOW_UNSUPPORTED_NODEJS}.
   */
  public static get allowUnsupportedNodeVersion(): boolean {
    EnvironmentConfiguration._ensureInitialized();
    return EnvironmentConfiguration._allowUnsupportedNodeVersion;
  }

  /**
   * Reads and validates environment variables. If any are invalid, this function will throw.
   */
  public static initialize(): void {
    EnvironmentConfiguration.reset();

    const unknownEnvVariables: string[] = [];
    for (const envVarName in process.env) {
      if (process.env.hasOwnProperty(envVarName) && envVarName.match(/^RUSH_/i)) {
        const value: string | undefined = process.env[envVarName];
        // Environment variables are only case-insensitive on Windows
        const normalizedEnvVarName: string = os.platform() === 'win32' ? envVarName.toUpperCase() : envVarName;
        switch (normalizedEnvVarName) {
          case EnvironmentVariableNames.RUSH_TEMP_FOLDER: {
            EnvironmentConfiguration._rushTempFolderOverride = value
              ? EnvironmentConfiguration._normalizeFirstExistingFolderPath(value) || value
              : value;
            break;
          }

          case EnvironmentVariableNames.RUSH_ABSOLUTE_SYMLINKS: {
            EnvironmentConfiguration._absoluteSymlinks = value === 'true';
            break;
          }

          case EnvironmentVariableNames.RUSH_ALLOW_UNSUPPORTED_NODEJS: {
            EnvironmentConfiguration._allowUnsupportedNodeVersion = value === 'true';
            break;
          }

          case EnvironmentVariableNames.RUSH_PREVIEW_VERSION:
          case EnvironmentVariableNames.RUSH_VARIANT:
            // Handled by @microsoft/rush front end
            break;
          default:
            unknownEnvVariables.push(envVarName);
            break;
        }
      }
    }

    // This strictness intends to catch mistakes where variables are misspelled or not used correctly.
    if (unknownEnvVariables.length > 0) {
      throw new Error(
        'The following environment variables were found with the "RUSH_" prefix, but they are not ' +
        `recognized by this version of Rush: ${unknownEnvVariables.join(', ')}`
      );
    }

    EnvironmentConfiguration._hasBeenInitialized = true;
  }

  /**
   * Resets EnvironmentConfiguration into an un-initialized state.
   */
  public static reset(): void {
    EnvironmentConfiguration._rushTempFolderOverride = undefined;

    EnvironmentConfiguration._hasBeenInitialized = false;
  }

  private static _ensureInitialized(): void {
    if (!EnvironmentConfiguration._hasBeenInitialized) {
      throw new Error('The EnvironmentConfiguration must be initialized before values can be accessed.');
    }
  }

  /**
   * Given a path to a folder (that may or may not exist), normalize the path, including casing,
   * to the first existing folder in the path.
   *
   * If no existing path can be found (for example, if the root is a volume that doesn't exist),
   * this function returns undefined
   *
   * @example
   * If the following path exists on disk: C:\Folder1\folder2\
   * _normalizeFirstExistingFolderPath('c:\\folder1\\folder2\\temp\\subfolder')
   * returns 'C:\\Folder1\\folder2\\temp\\subfolder'
   */
  private static _normalizeFirstExistingFolderPath(folderPath: string): string | undefined {
    folderPath = path.normalize(folderPath);
    const endsWithSlash: boolean = folderPath.charAt(folderPath.length - 1) === path.sep;
    const parsedPath: path.ParsedPath = path.parse(folderPath);
    const pathRoot: string = parsedPath.root;
    const pathWithoutRoot: String = parsedPath.dir.substr(pathRoot.length);
    const pathParts: string[] = [...pathWithoutRoot.split(path.sep), parsedPath.name].filter((part) => !!part);

    for (let i: number = pathParts.length; i >= 0; i--) {
      const constructedPath: string = path.join(pathRoot, ...pathParts.slice(0, i));
      try {
        const normalizedConstructedPath: string = trueCasePathSync(constructedPath);
        const result: string = path.join(normalizedConstructedPath, ...pathParts.slice(i));
        if (endsWithSlash) {
          return `${result}${path.sep}`;
        } else {
          return result;
        }
      } catch (e) {
        // This path doesn't exist, continue to the next
      }
    }

    return undefined;
  }
}
