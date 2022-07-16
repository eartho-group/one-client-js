pipeline {
  agent {
    label 'crew-brucke'
  }

  tools {
    nodejs '14.16.1'
  }

  options {
    timeout(time: 10, unit: 'MINUTES')
  }

  stages {
    stage('SharedLibs') {
      steps {
        library identifier: 'earthoOne-jenkins-pipelines-library@master', retriever: modernSCM(
          [$class: 'GitSCMSource',
          remote: 'git@github.com:earthoOne/earthoOne-jenkins-pipelines-library.git',
          credentialsId: 'earthoOneextensions-ssh-key'])
      }
    }
    stage('Build') {
      steps {
        sshagent(['earthoOneextensions-ssh-key']) {
          sh 'npm ci'
          sh 'npm run build'
        }
      }
    }
    stage('Test') {
      steps {
        script {
          try {
            sh 'npm run test'
            githubNotify context: 'jenkinsfile/earthoOne/tests', description: 'Tests passed', status: 'SUCCESS'
          } catch (error) {
            githubNotify context: 'jenkinsfile/earthoOne/tests', description: 'Tests failed', status: 'FAILURE'
            throw error
          }
        }
      }
    }
    stage('Publish to CDN') {
      when {
        branch 'master'
      }
      steps {
        sshagent(['earthoOneextensions-ssh-key']) {
          sh 'npm run publish:cdn'
        }
      }
    }
  }

  post {
    cleanup {
      deleteDir()
    }
  }
}
