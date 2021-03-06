/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

var when = require('when');
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var authResponseServer = require('./authServer').ResponseServer;
var sshResponseServer = require('./authServer').ResponseSSHServer;
var clone = require('clone');
var path = require("path");

var gitCommand = "git";
var gitVersion;
var log;

function runGitCommand(args,cwd,env) {
    log.trace(gitCommand + JSON.stringify(args));
    return when.promise(function(resolve,reject) {
        args.unshift("credential.helper=")
        args.unshift("-c");
        var child = spawn(gitCommand, args, {cwd:cwd, detached:true, env:env});
        var stdout = "";
        var stderr = "";
        child.stdout.on('data', function(data) {
            stdout += data;
        });

        child.stderr.on('data', function(data) {
            stderr += data;
        });

        child.on('close', function(code) {
            if (code !== 0) {
                var err = new Error(stderr);
                err.stdout = stdout;
                err.stderr = stderr;
                if (/fatal: could not read Username/.test(stderr)) {
                    err.code = "git_auth_failed";
                } else if(/HTTP Basic: Access denied/.test(stderr)) {
                    err.code = "git_auth_failed";
                } else if(/Permission denied \(publickey\)/.test(stderr)) {
                    err.code = "git_auth_failed";
                } else if(/Connection refused/.test(stderr)) {
                    err.code = "git_connection_failed";
                } else if (/commit your changes or stash/.test(stderr)) {
                    err.code = "git_local_overwrite";
                } else if (/CONFLICT/.test(err.stdout)) {
                    err.code = "git_pull_merge_conflict";
                } else if (/not fully merged/.test(stderr)) {
                    err.code = "git_delete_branch_unmerged";
                } else if (/remote .* already exists/.test(stderr)) {
                    err.code = "git_remote_already_exists";
                } else if (/does not appear to be a git repository/.test(stderr)) {
                    err.code = "git_not_a_repository";
                } else if (/Repository not found/i.test(stderr)) {
                    err.code = "git_repository_not_found";
                }
                return reject(err);
            }
            resolve(stdout);
        });
    });
}
function runGitCommandWithAuth(args,cwd,auth) {
    return authResponseServer(auth).then(function(rs) {
        var commandEnv = clone(process.env);
        commandEnv.GIT_ASKPASS = path.join(__dirname,"node-red-ask-pass.sh");
        commandEnv.NODE_RED_GIT_NODE_PATH = process.execPath;
        commandEnv.NODE_RED_GIT_SOCK_PATH = rs.path;
        commandEnv.NODE_RED_GIT_ASKPASS_PATH = path.join(__dirname,"authWriter.js");
        return runGitCommand(args,cwd,commandEnv).finally(function() {
            rs.close();
        });
    })
}

function runGitCommandWithSSHCommand(args,cwd,auth) {
    return sshResponseServer(auth).then(function(rs) {
        var commandEnv = clone(process.env);
        commandEnv.SSH_ASKPASS = path.join(__dirname,"node-red-ask-pass.sh");
        commandEnv.DISPLAY = "dummy:0";
        commandEnv.NODE_RED_GIT_NODE_PATH = process.execPath;
        commandEnv.NODE_RED_GIT_SOCK_PATH = rs.path;
        commandEnv.NODE_RED_GIT_ASKPASS_PATH = path.join(__dirname,"authWriter.js");
        commandEnv.GIT_SSH_COMMAND = "ssh -i " + auth.key_path + " -F /dev/null";
        // console.log('commandEnv:', commandEnv);
        return runGitCommand(args,cwd,commandEnv).finally(function() {
            rs.close();
        });
    })
}

function cleanFilename(name) {
    if (name[0] !== '"') {
        return name;
    }
    return name.substring(1,name.length-1);
}
function parseFilenames(name) {
    var re = /([^ "]+|(".*?"))($| -> ([^ ]+|(".*"))$)/;
    var m = re.exec(name);
    var result = [];
    if (m) {
        result.push(cleanFilename(m[1]));
        if (m[4]) {
            result.push(cleanFilename(m[4]));
        }
    }
    return result;
}
// function getBranchInfo(localRepo) {
//     return runGitCommand(["status","--porcelain","-b"],localRepo).then(function(output) {
//         var lines = output.split("\n");
//         var unknownDirs = [];
//         var branchLineRE = /^## (No commits yet on )?(.+?)($|\.\.\.(.+?)($| \[(ahead (\d+))?.*?(behind (\d+))?\]))/m;
//         console.log(output);
//         console.log(lines);
//         var m = branchLineRE.exec(output);
//         console.log(m);
//         var result = {}; //commits:{}};
//         if (m) {
//             if (m[1]) {
//                 result.empty = true;
//             }
//             result.local = m[2];
//             if (m[4]) {
//                 result.remote = m[4];
//             }
//         }
//         return result;
//     });
// }
function getStatus(localRepo) {
    // parseFilename('"test with space"');
    // parseFilename('"test with space" -> knownFile.txt');
    // parseFilename('"test with space" -> "un -> knownFile.txt"');
    var result = {
        files: {},
        commits: {},
        branches: {}
    }
    return runGitCommand(['rev-list', 'HEAD', '--count'],localRepo).then(function(count) {
        result.commits.total = parseInt(count);
    }).catch(function(err) {
        if (/ambiguous argument/.test(err.message)) {
            result.commits.total = 0;
        } else {
            throw err;
        }
    }).then(function() {
        return runGitCommand(["ls-files","--cached","--others","--exclude-standard"],localRepo).then(function(output) {
            var lines = output.split("\n");
            lines.forEach(function(l) {
                if (l==="") {
                    return;
                }
                var fullName = cleanFilename(l);
                // parseFilename(l);
                var parts = fullName.split("/");
                var p = result.files;
                var name;
                for (var i = 0;i<parts.length-1;i++) {
                    var name = parts.slice(0,i+1).join("/")+"/";
                    if (!p.hasOwnProperty(name)) {
                        p[name] = {
                            type:"d"
                        }
                    }
                }
                result.files[fullName] = {
                    type: /\/$/.test(fullName)?"d":"f"
                }
            })
            return runGitCommand(["status","--porcelain","-b"],localRepo).then(function(output) {
                var lines = output.split("\n");
                var unknownDirs = [];
                var branchLineRE = /^## (?:No commits yet on )?(.+?)(?:$|\.\.\.(.+?)(?:$| \[(?:(?:ahead (\d+)(?:,\s*)?)?(?:behind (\d+))?|(gone))\]))/;
                lines.forEach(function(line) {
                    if (line==="") {
                        return;
                    }
                    if (line[0] === "#") {
                        var m = branchLineRE.exec(line);
                        if (m) {
                            result.branches.local = m[1];
                            if (m[2]) {
                                result.branches.remote = m[2];
                                result.commits.ahead = 0;
                                result.commits.behind = 0;
                            }
                            if (m[3] !== undefined) {
                                result.commits.ahead = parseInt(m[3]);
                            }
                            if (m[4] !== undefined) {
                                result.commits.behind = parseInt(m[4]);
                            }
                            if (m[5] !== undefined) {
                                result.commits.ahead = result.commits.total;
                                result.branches.remoteError = {
                                    code: "git_remote_gone"
                                }
                            }
                        }
                        return;
                    }
                    var status = line.substring(0,2);
                    var fileName;
                    var names;
                    if (status !== '??') {
                        names = parseFilenames(line.substring(3));
                    } else {
                        names = [cleanFilename(line.substring(3))];
                    }
                    fileName = names[0];
                    if (names.length > 1) {
                        fileName = names[1];
                    }

                    // parseFilename(fileName);
                    if (fileName.charCodeAt(0) === 34) {
                        fileName = fileName.substring(1,fileName.length-1);
                    }
                    if (result.files.hasOwnProperty(fileName)) {
                        result.files[fileName].status = status;
                    } else {
                        result.files[fileName] = {
                            type: "f",
                            status: status
                        };
                    }
                    if (names.length > 1) {
                        result.files[fileName].oldName = names[0];
                    }
                    if (status === "??" && fileName[fileName.length-1] === '/') {
                        unknownDirs.push(fileName);
                    }
                })
                var allFilenames = Object.keys(result.files);
                allFilenames.forEach(function(f) {
                    var entry = result.files[f];
                    if (!entry.hasOwnProperty('status')) {
                        unknownDirs.forEach(function(uf) {
                            if (f.startsWith(uf)) {
                                entry.status = "??"
                            }
                        });
                    }
                })
                // console.log(files);
                return result;
            })
        })
    })
}

function parseLog(log) {
    var lines = log.split("\n");
    var currentCommit = {};
    var commits = [];
    lines.forEach(function(l) {
        if (l === "-----") {
            commits.push(currentCommit);
            currentCommit = {}
            return;
        }
        var m = /^(.*): (.*)$/.exec(l);
        if (m) {
            if (m[1] === 'refs' && m[2]) {
                currentCommit[m[1]] = m[2].split(",").map(function(v) { return v.trim() });
            } else {
                if (m[1] === 'parents') {
                    currentCommit[m[1]] = m[2].split(" ");
                } else {
                    currentCommit[m[1]] = m[2];
                }
            }
        }
    });
    return commits;
}

function getRemotes(cwd) {
    return runGitCommand(['remote','-v'],cwd).then(function(output) {
        var result;
        if (output.length > 0) {
            result = {};
            var remoteRE = /^(.+)\t(.+) \((.+)\)$/gm;
            var m;
            while ((m = remoteRE.exec(output)) !== null) {
                result[m[1]] = result[m[1]]||{};
                result[m[1]][m[3]] = m[2];
            }
        }
        return result;
    })
}

function getBranches(cwd, remote) {
    var args = ['branch','-vv','--no-color'];
    if (remote) {
        args.push('-r');
    }
    var branchRE = /^([ \*] )(\S+) +(\S+)(?: \[(\S+?)(?:: (?:ahead (\d+)(?:, )?)?(?:behind (\d+))?)?\])? (.*)$/;
    return runGitCommand(args,cwd).then(function(output) {
        var branches = [];
        var lines = output.split("\n");
        branches = lines.map(function(l) {
            var m = branchRE.exec(l);
            var branch = null;
            if (m) {
                branch = {
                    name: m[2],
                    remote: m[4],
                    status: {
                        ahead: m[5]||0,
                        behind: m[6]||0,
                    },
                    commit: {
                        sha: m[3],
                        subject: m[7]
                    }
                }
                if (m[1] === '* ') {
                    branch.current = true;
                }
            }
            return branch;
        }).filter(function(v) { return !!v && v.commit.sha !== '->' });

        return {branches:branches};
    })
}
function getBranchStatus(cwd,remoteBranch) {
    var commands = [
        // #commits master ahead
        runGitCommand(['rev-list', 'HEAD','^'+remoteBranch, '--count'],cwd),
        // #commits master behind
        runGitCommand(['rev-list', '^HEAD',remoteBranch, '--count'],cwd)
    ];
    return when.all(commands).then(function(results) {
        return {
            commits: {
                ahead: parseInt(results[0]),
                behind: parseInt(results[1])
            }
        }
    })
}

function addRemote(cwd,name,options) {
    var args = ["remote","add",name,options.url]
    return runGitCommand(args,cwd);
}
function removeRemote(cwd,name) {
    var args = ["remote","remove",name];
    return runGitCommand(args,cwd);
}

module.exports = {
    init: function(_settings,_runtime) {
        log = _runtime.log
        return new Promise(function(resolve,reject) {
            Promise.all([
                runGitCommand(["--version"]),
                runGitCommand(["config","--global","user.name"]).catch(err=>""),
                runGitCommand(["config","--global","user.email"]).catch(err=>"")
            ]).then(function(output) {
                var m = / (\d\S+)/.exec(output[0]);
                gitVersion = m[1];
                var globalUserName = output[1].trim();
                var globalUserEmail = output[2].trim();
                var result = {
                    version: gitVersion
                };
                if (globalUserName && globalUserEmail) {
                    result.user = {
                        name: globalUserName,
                        email: globalUserEmail
                    }
                }
                resolve(result);
            }).catch(function(err) {
                console.log(err);
                resolve(null);
            });
        });
    },
    initRepo: function(cwd) {
        return runGitCommand(["init"],cwd);
    },
    setUpstream: function(cwd,remoteBranch) {
        var args = ["branch","--set-upstream-to",remoteBranch];
        return runGitCommand(args,cwd);
    },
    pull: function(cwd,remote,branch,auth) {
        var args = ["pull"];
        if (remote && branch) {
            args.push(remote);
            args.push(branch);
        }
        var promise;
        if (auth) {
            if ( auth.key_path ) {
                promise = runGitCommandWithSSHCommand(args,cwd,auth);
            }
            else {
                promise = runGitCommandWithAuth(args,cwd,auth);
            }
        } else {
            promise = runGitCommand(args,cwd)
        }
        return promise.catch(function(err) {
            if (/CONFLICT/.test(err.stdout)) {
                var e = new Error("NLS: pull failed - merge conflict");
                e.code = "git_pull_merge_conflict";
                throw e;
            } else if (/Please commit your changes or stash/.test(err.message)) {
                var e = new Error("NLS: Pull failed - local changes would be overwritten");
                e.code = "git_pull_overwrite";
                throw e;
            }
            throw err;
        });
    },
    push: function(cwd,remote,branch,setUpstream, auth) {
        var args = ["push"];
        if (branch) {
            if (setUpstream) {
                args.push("-u");
            }
            args.push(remote);
            args.push("HEAD:"+branch);
        } else {
            args.push(remote);
        }
        args.push("--porcelain");
        var promise;
        if (auth) {
            if ( auth.key_path ) {
                promise = runGitCommandWithSSHCommand(args,cwd,auth);
            }
            else {
                promise = runGitCommandWithAuth(args,cwd,auth);
            }
        } else {
            promise = runGitCommand(args,cwd)
        }
        return promise.catch(function(err) {
            if (err.code === 'git_error') {
                if (/^!.*non-fast-forward/m.test(err.stdout)) {
                    err.code = 'git_push_failed';
                }
                throw err;
            } else {
                throw err;
            }
        });
    },
    clone: function(remote, auth, cwd) {
        var args = ["clone",remote.url];
        if (remote.name) {
            args.push("-o");
            args.push(remote.name);
        }
        if (remote.branch) {
            args.push("-b");
            args.push(remote.branch);
        }
        args.push(".");
        if (auth) {
            if ( auth.key_path ) {
                return runGitCommandWithSSHCommand(args,cwd,auth);
            }
            else {
                return runGitCommandWithAuth(args,cwd,auth);
            }
        } else {
            return runGitCommand(args,cwd);
        }
    },
    getStatus: getStatus,
    getFile: function(cwd, filePath, treeish) {
        var args = ["show",treeish+":"+filePath];
        return runGitCommand(args,cwd);
    },
    getFiles: function(cwd) {
        return getStatus(cwd).then(function(status) {
            return status.files;
        })
    },
    revertFile: function(cwd, filePath) {
        var args = ["checkout",filePath];
        return runGitCommand(args,cwd);
    },
    stageFile: function(cwd,file) {
        var args = ["add"];
        if (Array.isArray(file)) {
            args = args.concat(file);
        } else {
            args.push(file);
        }
        return runGitCommand(args,cwd);
    },
    unstageFile: function(cwd, file) {
        var args = ["reset","--"];
        if (file) {
            args.push(file);
        }
        return runGitCommand(args,cwd);
    },
    commit: function(cwd, message, gitUser) {
        var args = ["commit","-m",message];
        var env;
        if (gitUser && gitUser['name'] && gitUser['email']) {
            args.unshift('user.name="'+gitUser['name']+'"');
            args.unshift('-c');
            args.unshift('user.email="'+gitUser['email']+'"');
            args.unshift('-c');
        }
        return runGitCommand(args,cwd,env);
    },
    getFileDiff(cwd,file,type) {
        var args = ["diff"];
        if (type === "tree") {
            // nothing else to do
        } else if (type === "index") {
            args.push("--cached");
        }
        args.push(file);
        return runGitCommand(args,cwd);
    },
    fetch: function(cwd,remote,auth) {
        var args = ["fetch",remote];
        if (auth) {
            if ( auth.key_path ) {
                return runGitCommandWithSSHCommand(args,cwd,auth);
            }
            else {
                return runGitCommandWithAuth(args,cwd,auth);
            }
        } else {
            return runGitCommand(args,cwd);
        }
    },
    getCommits: function(cwd,options) {
        var args = ["log", "--format=sha: %H%nparents: %p%nrefs: %D%nauthor: %an%ndate: %ct%nsubject: %s%n-----"];
        var limit = parseInt(options.limit) || 20;
        args.push("-n "+limit);
        var before = options.before;
        if (before) {
            args.push(before);
        }
        var commands = [
            runGitCommand(['rev-list', 'HEAD', '--count'],cwd),
            runGitCommand(args,cwd).then(parseLog)
        ];
        return when.all(commands).then(function(results) {
            var result = results[0];
            result.count = results[1].length;
            result.before = before;
            result.commits = results[1];
            return {
                count: results[1].length,
                commits: results[1],
                before: before,
                total: parseInt(results[0])
            };
        })
    },
    getCommit: function(cwd,sha) {
        var args = ["show",sha];
        return runGitCommand(args,cwd);
    },
    abortMerge: function(cwd) {
        return runGitCommand(['merge','--abort'],cwd);
    },
    getRemotes: getRemotes,
    getRemoteBranch: function(cwd) {
        return runGitCommand(['rev-parse','--abbrev-ref','--symbolic-full-name','@{u}'],cwd).catch(function(err) {
            if (/no upstream configured for branch/.test(err.message)) {
                return null;
            }
            throw err;
        })
    },
    getBranches: getBranches,
    // getBranchInfo: getBranchInfo,
    checkoutBranch: function(cwd, branchName, isCreate) {
        var args = ['checkout'];
        if (isCreate) {
            args.push('-b');
        }
        args.push(branchName);
        return runGitCommand(args,cwd);
    },
    deleteBranch: function(cwd, branchName, isRemote, force) {
        if (isRemote) {
            throw new Error("Deleting remote branches not supported");
        }
        var args = ['branch'];
        if (force) {
            args.push('-D');
        } else {
            args.push('-d');
        }
        args.push(branchName);
        return runGitCommand(args, cwd);
    },
    getBranchStatus: getBranchStatus,
    addRemote: addRemote,
    removeRemote: removeRemote
}
